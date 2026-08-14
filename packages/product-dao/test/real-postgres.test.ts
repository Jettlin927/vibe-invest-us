import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'

import { defaultRuntimeSettings } from '@vibe-invest/contracts'

import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createPool,
  createPortfolioRepository, createRuntimeSettingsRepository, createToolProjectionRepository, migrate,
} from '../src/index.js'

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL
const applicationUrl = process.env.TEST_DATABASE_URL

async function removeResearchFixture(pool: Pool, analysisId: string) {
  await pool.query(
    `UPDATE agent_executions execution
     SET status = 'stopped', terminal = true, updated_at = now()
     FROM agent_sessions session
     WHERE execution.session_id = session.id
       AND session.analysis_id = $1 AND execution.terminal = false`,
    [analysisId],
  )
  await pool.query(
    `UPDATE agent_sessions SET status = 'stopped', updated_at = now()
     WHERE analysis_id = $1`,
    [analysisId],
  )
  return createAnalysisRepository(pool).removeResearch(analysisId)
}

test('真实 PostgreSQL 持久化 Tool Projection 版本、模型请求与批次边界并可重放', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `projection-${crypto.randomUUID()}`
  const sessionId = `projection-session-${crypto.randomUUID()}`
  const executionId = `projection-execution-${crypto.randomUUID()}`
  const otherAnalysisId = `projection-other-${crypto.randomUUID()}`
  const otherExecutionId = `projection-other-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `P${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T04:00:00.000Z',
    })
    const first = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'hash-research',
      projectedTools: [{ name: 'fetch_financial_context', parameters: { type: 'object' } }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-13T04:00:01.000Z',
    })
    const same = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'hash-research',
      projectedTools: [{ name: 'fetch_financial_context', parameters: { type: 'object' } }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-13T04:00:02.000Z',
    })
    assert.equal(first.version, 1)
    assert.deepEqual(same, first)
    const eligibilityProjection = await projections.ensureVersion({
      executionId, role: 'news', stage: 'research', schemaHash: 'hash-web-eligible',
      projectedTools: [{ name: 'search_web_evidence', parameters: { type: 'object' } }],
      visibleToolNames: ['search_web_evidence'], reasons: { eligibility: true },
      causativeEvent: {
        operationId: 'web-search-eligibility:1', payload: {
          type: 'web_search_eligibility', query: 'NVDA', eligible: true,
          reasons: [{ source: 'one', reason: 'empty' }, { source: 'two', reason: 'irrelevant' },
            { source: 'three', reason: 'title_only' }],
        },
      },
      createdAt: '2026-08-13T04:00:02.005Z',
    })
    assert.equal(eligibilityProjection.event?.payload.type, 'web_search_eligibility')
    const replayedEligibilityProjection = await projections.ensureVersion({
      executionId, role: 'news', stage: 'research', schemaHash: 'hash-web-eligible',
      projectedTools: [{ name: 'search_web_evidence', parameters: { type: 'object' } }],
      visibleToolNames: ['search_web_evidence'], reasons: { eligibility: true },
      causativeEvent: {
        operationId: 'web-search-eligibility:1', payload: {
          type: 'web_search_eligibility', query: 'NVDA', eligible: true,
          reasons: [{ source: 'one', reason: 'empty' }, { source: 'two', reason: 'irrelevant' },
            { source: 'three', reason: 'title_only' }],
        },
      },
      createdAt: '2026-08-13T04:00:02.005Z',
    })
    assert.equal(replayedEligibilityProjection.id, eligibilityProjection.id)
    assert.equal(replayedEligibilityProjection.event, undefined)
    const eligibilityEvent = (await events.list(sessionId, 0)).find(
      ({ operationId }) => operationId === 'web-search-eligibility:1',
    )
    assert.ok(eligibilityEvent)
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'news', stage: 'research', schemaHash: 'hash-web-conflict',
      projectedTools: [], visibleToolNames: [], reasons: { eligibility: false },
      causativeEvent: {
        operationId: 'web-search-eligibility:1', payload: {
          type: 'web_search_eligibility', query: 'NVDA', eligible: false, reasons: [],
        },
      }, createdAt: '2026-08-13T04:00:02.006Z',
    }), /tool_projection_causative_event_conflict/)
    const conflictProjection = await pool.query(
      `SELECT 1 FROM tool_projection_versions WHERE execution_id = $1 AND schema_hash = 'hash-web-conflict'`,
      [executionId],
    )
    assert.equal(conflictProjection.rowCount, 0)
    const concurrent = await Promise.all([
      projections.ensureVersion({
        executionId, role: 'fundamental', stage: 'research', schemaHash: 'hash-concurrent-a',
        projectedTools: [{ name: 'search_news_by_keyword', parameters: { type: 'object' } }],
        visibleToolNames: ['search_news_by_keyword'], reasons: { stage: 'research' },
        createdAt: '2026-08-13T04:00:02.010Z',
      }),
      projections.ensureVersion({
        executionId, role: 'fundamental', stage: 'finalization', schemaHash: 'hash-concurrent-b',
        projectedTools: [], visibleToolNames: [], reasons: { stage: 'finalization' },
        createdAt: '2026-08-13T04:00:02.020Z',
      }),
    ])
    assert.deepEqual(concurrent.map(({ version }) => version).sort((left, right) => left - right), [3, 4])
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'hash-research',
      projectedTools: [{ name: 'different_tool', parameters: { type: 'object' } }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-13T04:00:02.000Z',
    }), /tool_projection_conflict/)
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'unknown' as never, stage: 'research', schemaHash: 'hash-invalid-role',
      projectedTools: [], visibleToolNames: [], reasons: {},
      createdAt: '2026-08-13T04:00:02.100Z',
    }), /tool_projection_versions_role_check/)
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'main', stage: 'unknown' as never, schemaHash: 'hash-invalid-stage',
      projectedTools: [], visibleToolNames: [], reasons: {},
      createdAt: '2026-08-13T04:00:02.200Z',
    }), /tool_projection_versions_stage_check/)
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'hash-research',
      projectedTools: [{ name: 'fetch_financial_context', parameters: { type: 'object' } }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'different' },
      createdAt: '2026-08-13T04:00:02.000Z',
    }), /tool_projection_conflict/)

    await projections.recordModelRequest({
      id: 'request-1', executionId, projectionId: first.id, turnIndex: 1,
      createdAt: '2026-08-13T04:00:03.000Z',
    })
    await projections.recordModelRequest({
      id: 'request-1', executionId, projectionId: first.id, turnIndex: 1,
      createdAt: '2026-08-13T04:00:03.000Z',
    })
    await assert.rejects(projections.recordModelRequest({
      id: 'request-1', executionId, projectionId: first.id, turnIndex: 2,
      createdAt: '2026-08-13T04:00:03.000Z',
    }), /model_request_conflict/)
    await projections.beginToolBatch({
      id: 'batch-1', executionId, projectionId: first.id, turnIndex: 1,
      calls: [{ toolCallId: 'call-2', toolName: 'fetch_financial_context', position: 2 },
        { toolCallId: 'call-1', toolName: 'fetch_financial_context', position: 1 }],
      createdAt: '2026-08-13T04:00:04.000Z',
    })
    const call1Start = {
      batchId: 'batch-1', executionId, toolCallId: 'call-1',
      startedAt: '2026-08-13T04:00:04.100Z', operationId: 'batch-1:call:call-1',
      eventPayload: { type: 'trace', kind: 'tool_call', toolCallId: 'call-1', startedAt: '2026-08-13T04:00:04.100Z' },
    }
    const call2Start = {
      batchId: 'batch-1', executionId, toolCallId: 'call-2',
      startedAt: '2026-08-13T04:00:04.200Z', operationId: 'batch-1:call:call-2',
      eventPayload: { type: 'trace', kind: 'tool_call', toolCallId: 'call-2', startedAt: '2026-08-13T04:00:04.200Z' },
    }
    const firstStart = await projections.startToolCall(call1Start)
    assert.deepEqual(await projections.startToolCall(call1Start), firstStart)
    await projections.startToolCall(call2Start)
    await assert.rejects(projections.startToolCall({
      ...call1Start, startedAt: '2026-08-13T04:00:04.101Z',
    }), /tool_call_start_conflict/)
    await assert.rejects(pool.query(
      `UPDATE tool_batch_calls SET status = 'completed'
       WHERE batch_id = 'batch-1' AND tool_call_id = 'call-1'`,
    ), /tool_batch_calls_completion_check/)
    await assert.rejects(projections.ensureVersion({
      executionId, role: 'main', stage: 'finalization', schemaHash: 'hash-final',
      projectedTools: [{ name: 'submit_analysis_report', parameters: { type: 'object' } }],
      visibleToolNames: ['submit_analysis_report'], reasons: { stage: 'finalization' },
      createdAt: '2026-08-13T04:00:05.000Z',
    }), /tool_batch_not_terminal/)
    await assert.rejects(projections.completeToolBatch({
      id: 'batch-1', executionId,
      results: [{
        toolCallId: 'call-1', status: 'completed', startedAt: '2026-08-13T04:00:04.100Z',
        completedAt: '2026-08-13T04:00:05.000Z', completionOrder: 1,
        resultPayload: { toolCallId: 'call-1', content: 'first', isError: false }, operationId: 'batch-1:result:call-1',
        eventPayload: { type: 'trace', kind: 'tool_result', toolCallId: 'call-1', content: 'first' },
      }],
      completedAt: '2026-08-13T04:00:06.000Z',
    }), /tool_batch_results_incomplete/)
    assert.equal((await projections.replay(executionId)).toolBatches[0]?.status, 'running')
    assert.equal((await events.list(sessionId, 1)).length, 3)
    const completedBatch = {
      id: 'batch-1', executionId,
      results: [{
        toolCallId: 'call-2', status: 'failed', startedAt: '2026-08-13T04:00:04.200Z',
        completedAt: '2026-08-13T04:00:05.500Z', completionOrder: 2,
        resultPayload: { toolCallId: 'call-2', content: 'second', isError: true }, operationId: 'batch-1:result:call-2',
        eventPayload: { type: 'trace', kind: 'tool_result', toolCallId: 'call-2', content: 'second' },
      }, {
        toolCallId: 'call-1', status: 'completed', startedAt: '2026-08-13T04:00:04.100Z',
        completedAt: '2026-08-13T04:00:05.000Z', completionOrder: 1,
        resultPayload: { toolCallId: 'call-1', content: 'first', isError: false }, operationId: 'batch-1:result:call-1',
        eventPayload: { type: 'trace', kind: 'tool_result', toolCallId: 'call-1', content: 'first' },
      }],
      completedAt: '2026-08-13T04:00:06.000Z',
    } as const
    await assert.rejects(projections.completeToolBatch({
      ...completedBatch,
      results: completedBatch.results.map((result) => result.toolCallId === 'call-1'
        ? { ...result, startedAt: '2026-08-13T04:00:04.999Z' }
        : result),
    }), /tool_batch_started_at_conflict/)
    const firstCompletion = await projections.completeToolBatch(completedBatch)
    const ledgerAfterCompletion = await events.list(sessionId, 0)
    await assert.rejects(projections.startToolCall(call1Start), /tool_call_not_running/)
    assert.deepEqual(await events.list(sessionId, 0), ledgerAfterCompletion)
    const retriedCompletion = await projections.completeToolBatch(completedBatch)
    assert.deepEqual(retriedCompletion, firstCompletion)
    assert.equal((await events.list(sessionId, 1)).length, 5)
    await assert.rejects(projections.completeToolBatch({
      ...completedBatch,
      results: completedBatch.results.map((result) => result.toolCallId === 'call-1'
        ? { ...result, resultPayload: { content: 'tampered', isError: false } }
        : result),
    }), /tool_batch_completion_conflict/)
    const second = await projections.ensureVersion({
      executionId, role: 'main', stage: 'finalization', schemaHash: 'hash-final',
      projectedTools: [{ name: 'submit_analysis_report', parameters: { type: 'object' } }],
      visibleToolNames: ['submit_analysis_report'], reasons: { stage: 'finalization' },
      createdAt: '2026-08-13T04:00:07.000Z',
    })
    await projections.recordModelRequest({
      id: 'request-2', executionId, projectionId: second.id, turnIndex: 2,
      createdAt: '2026-08-13T04:00:08.000Z',
    })
    await projections.recordModelRequest({
      id: 'request-z', executionId, projectionId: second.id, turnIndex: 3,
      createdAt: '2026-08-13T04:00:09.000Z',
    })
    await projections.recordModelRequest({
      id: 'request-a', executionId, projectionId: second.id, turnIndex: 3,
      createdAt: '2026-08-13T04:00:09.000Z',
    })
    assert.equal(second.version, 5)
    const replay = await projections.replay(executionId)
    assert.deepEqual(replay.projections.map(({ version, visibleToolNames }) => ({ version, visibleToolNames })), [
      { version: 1, visibleToolNames: ['fetch_financial_context'] },
      { version: 2, visibleToolNames: ['search_web_evidence'] },
      { version: 3, visibleToolNames: ['search_news_by_keyword'] },
      { version: 4, visibleToolNames: [] },
      { version: 5, visibleToolNames: ['submit_analysis_report'] },
    ])
    assert.deepEqual(replay.modelRequests.map(({ id, projectionVersion }) => ({ id, projectionVersion })), [
      { id: 'request-1', projectionVersion: 1 }, { id: 'request-2', projectionVersion: 5 },
      { id: 'request-a', projectionVersion: 5 }, { id: 'request-z', projectionVersion: 5 },
    ])
    assert.equal(replay.toolBatches[0]?.projectionVersion, 1)
    assert.equal(replay.toolBatches[0]?.status, 'failed')
    assert.deepEqual(replay.toolBatches[0]?.calls.map(({ toolCallId }) => toolCallId), ['call-1', 'call-2'])
    assert.deepEqual(replay.toolBatches[0]?.results.map(({ toolCallId, status, completionOrder }) => ({
      toolCallId, status, completionOrder,
    })), [
      { toolCallId: 'call-1', status: 'completed', completionOrder: 1 },
      { toolCallId: 'call-2', status: 'failed', completionOrder: 2 },
    ])
    assert.deepEqual(replay.toolBatches[0]?.results.map(({ resultPayload }) => resultPayload), [
      { toolCallId: 'call-1', content: 'first', isError: false },
      { toolCallId: 'call-2', content: 'second', isError: true },
    ])
    const resultEvents = (await events.list(sessionId, 1))
      .filter(({ payload }) => payload.toolCallId)
      .map(({ operationId, payload }) => ({
      operationId, toolCallId: payload.toolCallId,
      }))
    assert.deepEqual(resultEvents, [
      { operationId: 'batch-1:call:call-1', toolCallId: 'call-1' },
      { operationId: 'batch-1:call:call-2', toolCallId: 'call-2' },
      { operationId: 'batch-1:result:call-1', toolCallId: 'call-1' },
      { operationId: 'batch-1:result:call-2', toolCallId: 'call-2' },
    ])
    assert.equal((await projections.replayForSession(sessionId, executionId))?.executionId, executionId)
    assert.equal(await projections.replayForSession(`not-${sessionId}`, executionId), null)
    await assert.rejects(pool.query(
      `UPDATE tool_call_batches SET projection_id = $1 WHERE id = 'batch-1'`, [second.id],
    ), /permission denied/)

    await events.createResearch({
      analysisId: otherAnalysisId, sessionId: `projection-other-session-${crypto.randomUUID()}`,
      executionId: otherExecutionId, symbol: `O${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T04:00:10.000Z',
    })
    await assert.rejects(projections.beginToolBatch({
      id: 'cross-execution-batch', executionId: otherExecutionId, projectionId: first.id,
      turnIndex: 1, calls: [], createdAt: '2026-08-13T04:00:11.000Z',
    }), /foreign key constraint/)
  } finally {
    await removeResearchFixture(pool, otherAnalysisId)
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 保存 Provider attempt 四类 Token、状态和 coverage 且重放不重复', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `model-usage-${crypto.randomUUID()}`
  const sessionId = `model-usage-session-${crypto.randomUUID()}`
  const executionId = `model-usage-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol: `U${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context' }, createdAt: '2026-08-14T03:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'model-usage',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T03:00:00.100Z',
    })
    const request = {
      id: `${executionId}:model-attempt:1`, executionId, projectionId: projection.id,
      turnIndex: 1, kind: 'turn' as const, createdAt: '2026-08-14T03:00:01.000Z',
    }
    await projections.recordModelRequest(request)
    const completion = {
      id: request.id, executionId, status: 'completed' as const,
      usageStatus: 'complete' as const,
      usage: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, total: 135 },
      completedAt: '2026-08-14T03:00:01.250Z',
    }
    await projections.completeModelRequest(completion)
    await projections.completeModelRequest(completion)
    await assert.rejects(projections.completeModelRequest({
      ...completion, usage: { ...completion.usage, output: 11, total: 136 },
    }), /model_request_conflict/)
    const inconsistentRequest = {
      id: `${executionId}:model-attempt:2`, executionId, projectionId: projection.id,
      turnIndex: 2, kind: 'turn' as const, createdAt: '2026-08-14T03:00:02.000Z',
    }
    await projections.recordModelRequest(inconsistentRequest)
    await assert.rejects(projections.completeModelRequest({
      id: inconsistentRequest.id, executionId, status: 'completed', usageStatus: 'complete',
      usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, total: 99 },
      completedAt: '2026-08-14T03:00:02.100Z',
    }), /model_requests_usage_consistency_check/)
    await projections.completeModelRequest({
      id: inconsistentRequest.id, executionId, status: 'completed', usageStatus: 'partial',
      usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, total: 99 },
      completedAt: '2026-08-14T03:00:02.100Z',
    })

    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.deepEqual(lifecycle?.modelAttempts, [{
      id: request.id, executionId, kind: 'turn', turnIndex: 1, status: 'completed',
      usageStatus: 'complete',
      usage: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, total: 135 },
      durationMs: 250,
      createdAt: '2026-08-14T03:00:01.000Z',
      completedAt: '2026-08-14T03:00:01.250Z',
    }, {
      id: inconsistentRequest.id, executionId, kind: 'turn', turnIndex: 2,
      status: 'completed', usageStatus: 'partial',
      usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, total: 99 },
      durationMs: 100, createdAt: '2026-08-14T03:00:02.000Z',
      completedAt: '2026-08-14T03:00:02.100Z',
    }])
    assert.deepEqual(lifecycle?.tokenUsage, {
      attempts: 2, reportedAttempts: 2, coverage: 1,
      input: 110, cacheRead: 22, cacheWrite: 6, output: 13, total: 234,
    })
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 模型 attempt 在 execution 终态后仍可精确重放且冲突 fail closed', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `model-replay-${crypto.randomUUID()}`
  const sessionId = `model-replay-session-${crypto.randomUUID()}`
  const executionId = `model-replay-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol: `R${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context' }, createdAt: '2026-08-14T03:15:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'model-replay',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T03:15:00.100Z',
    })
    const requestId = `${executionId}:model-attempt:1`
    await projections.recordModelRequest({
      id: requestId, executionId, projectionId: projection.id, turnIndex: 1,
      createdAt: '2026-08-14T03:15:01.000Z',
    })
    const completion = {
      id: requestId, executionId, status: 'completed' as const,
      usageStatus: 'complete' as const,
      usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, total: 16 },
      completedAt: '2026-08-14T03:15:01.100Z',
    }
    await projections.completeModelRequest(completion)
    await events.append({
      sessionId, executionId, operationId: 'model-replay-completed',
      event: { type: 'status', status: 'completed' },
      projection: { status: 'completed', executionStatus: 'completed', terminal: true },
      createdAt: '2026-08-14T03:15:02.000Z',
    })
    assert.equal((await projections.completeModelRequest(completion)).created, false)
    await assert.rejects(projections.completeModelRequest({
      ...completion, usage: { ...completion.usage, output: 4, total: 17 },
    }), /model_request_conflict/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL v21 经当前迁移将未终态模型请求封存为 outcome_unknown', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const appPool = createPool(applicationUrl!)
  const migrationPool = createPool(migrationUrl!)
  const events = createAgentEventRepository(appPool)
  const projections = createToolProjectionRepository(appPool)
  const analysisId = `v21-model-request-${crypto.randomUUID()}`
  const sessionId = `v21-model-session-${crypto.randomUUID()}`
  const executionId = `v21-model-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol: `M${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context' }, createdAt: '2026-08-14T03:30:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'v21-model-request',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T03:30:00.100Z',
    })
    await projections.recordModelRequest({
      id: `execution:${executionId}:main:compaction:1:attempt:1`, executionId,
      projectionId: projection.id, turnIndex: 1,
      createdAt: '2026-08-14T03:30:01.000Z',
    })
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version >= 22')
    await migrate(migrationUrl!)
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.modelAttempts[0]?.status, 'outcome_unknown')
    assert.equal(lifecycle?.modelAttempts[0]?.kind, 'compaction')
    assert.equal(lifecycle?.modelAttempts[0]?.usageStatus, 'unknown')
    assert.deepEqual(lifecycle?.modelAttempts[0]?.usage, {
      input: null, cacheRead: null, cacheWrite: null, output: null, total: null,
    })
    assert.deepEqual(await checkSchema(appPool), { status: 'ok', version: 24 })
  } finally {
    await removeResearchFixture(appPool, analysisId)
    await migrationPool.query(
      `INSERT INTO product_schema_migrations (version) VALUES (22), (23), (24)
       ON CONFLICT DO NOTHING`,
    )
    await appPool.end()
    await migrationPool.end()
  }
})

test('真实 PostgreSQL v22 接受技术面 Tool Projection 角色', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const suffix = crypto.randomUUID()
  const analysisId = `technical-projection-${suffix}`
  const sessionId = `technical-session-${suffix}`
  const executionId = `technical-execution-${suffix}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `T${suffix.slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-14T00:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'technical', stage: 'research', schemaHash: 'technical-v1',
      projectedTools: [{ name: 'get_technical_evidence' }],
      visibleToolNames: ['get_technical_evidence'], reasons: { role: 'technical' },
      createdAt: '2026-08-14T00:00:01.000Z',
    })
    assert.equal(projection.role, 'technical')
    assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 24 })
  } finally {
    const cleanup = createPool(migrationUrl!)
    await cleanup.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await cleanup.end()
    await pool.end()
  }
})

test('真实 PostgreSQL execution 终态事务会取消未完成 Tool Batch', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `projection-terminal-${crypto.randomUUID()}`
  const sessionId = `projection-terminal-session-${crypto.randomUUID()}`
  const executionId = `projection-terminal-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `T${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T04:10:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'terminal-hash',
      projectedTools: [{ name: 'fetch_financial_context', parameters: { type: 'object' } }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-13T04:10:01.000Z',
    })
    await projections.beginToolBatch({
      id: 'terminal-batch', executionId, projectionId: projection.id, turnIndex: 1,
      calls: [{ toolCallId: 'terminal-call', toolName: 'fetch_financial_context', position: 1 }],
      createdAt: '2026-08-13T04:10:02.000Z',
    })
    const terminalStart = {
      batchId: 'terminal-batch', executionId, toolCallId: 'terminal-call',
      startedAt: '2026-08-13T04:10:02.500Z', operationId: 'terminal-call-start',
      eventPayload: { type: 'tool_call', name: 'fetch_financial_context', startedAt: '2026-08-13T04:10:02.500Z' },
    }
    const terminalStartEvent = await projections.startToolCall(terminalStart)
    await projections.recordModelRequest({
      id: `${executionId}:model-attempt:1`, executionId, projectionId: projection.id,
      turnIndex: 1, createdAt: '2026-08-13T04:10:02.600Z',
    })
    await events.append({
      sessionId, executionId, operationId: 'execution-failed',
      event: { type: 'status', status: 'failed', terminal: true },
      projection: { status: 'failed', executionStatus: 'failed', terminal: true },
      createdAt: '2026-08-13T04:10:03.000Z',
    })
    const ledgerBeforeLateStart = await events.list(sessionId, 0)
    await assert.rejects(projections.startToolCall(terminalStart), /agent_execution_fenced/)
    assert.deepEqual(await events.list(sessionId, 0), ledgerBeforeLateStart)
    const replay = await projections.replay(executionId)
    assert.equal(replay.toolBatches[0]?.status, 'cancelled')
    assert.deepEqual(replay.toolBatches[0]?.results.map(({ status }) => status), ['cancelled'])
    assert.deepEqual(replay.toolBatches[0]?.results.map((result) => ({
      startedAt: result.startedAt, completedAt: result.completedAt,
      completionOrder: result.completionOrder, resultPayload: result.resultPayload,
    })), [{
      startedAt: '2026-08-13T04:10:02.500Z', completedAt: '2026-08-13T04:10:03.000Z',
      completionOrder: 1, resultPayload: {
        toolName: 'fetch_financial_context', toolCallId: 'terminal-call',
        result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      },
    }])
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.modelAttempts[0]?.status, 'outcome_unknown')
    assert.equal(lifecycle?.modelAttempts[0]?.completedAt, '2026-08-13T04:10:03.000Z')
    await assert.rejects(projections.recordModelRequest({
      id: 'late-request', executionId, projectionId: projection.id, turnIndex: 2,
      createdAt: '2026-08-13T04:10:04.000Z',
    }), /agent_execution_fenced/)
    await assert.rejects(projections.completeToolBatch({
      id: 'terminal-batch', executionId,
      results: [{
        toolCallId: 'terminal-call', status: 'completed', startedAt: '2026-08-13T04:10:02.000Z',
        completedAt: '2026-08-13T04:10:04.000Z', completionOrder: 1,
        resultPayload: { content: 'late', isError: false }, operationId: 'terminal-result',
        eventPayload: { type: 'trace', kind: 'tool_result', toolCallId: 'terminal-call' },
      }],
      completedAt: '2026-08-13T04:10:04.000Z',
    }), /tool_batch_completion_conflict/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 保存不可变 Runtime settings revision 并可恢复默认值', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  try {
    const defaults = await settings.restoreDefaults('2026-08-13T01:00:00.000Z')
    const changed = await settings.save({
      mainAgentToolRounds: 100,
      modelRequestTimeoutMinutes: 60,
    }, '2026-08-13T01:01:00.000Z')
    const restored = await settings.restoreDefaults('2026-08-13T01:02:00.000Z')

    assert.notEqual(defaults.id, changed.id)
    assert.notEqual(changed.id, restored.id)
    assert.equal((await settings.getRevision(changed.id))?.values.mainAgentToolRounds, 100)
    assert.equal((await settings.getRevision(changed.id))?.values.modelRequestTimeoutMinutes, 60)
    assert.equal(restored.values.mainAgentToolRounds, 20)
    assert.equal(restored.values.modelRequestTimeoutMinutes, 15)
    await assert.rejects(
      pool.query('UPDATE runtime_settings_revisions SET settings_json = $1 WHERE id = $2', ['{}', changed.id]),
      /permission denied/,
    )
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL execution 冻结 settings snapshot 后不随新 revision 改变', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const executionId = 'settings-snapshot-execution'
  try {
    await settings.restoreDefaults('2026-08-13T02:00:00.000Z')
    const frozen = await settings.freezeExecution(executionId, '2026-08-13T02:01:00.000Z')
    await settings.save({ mainAgentToolRounds: 200 }, '2026-08-13T02:02:00.000Z')

    assert.equal(frozen.values.mainAgentToolRounds, 20)
    assert.equal((await settings.getExecutionSnapshot(executionId))?.values.mainAgentToolRounds, 20)
    assert.equal((await settings.current()).values.mainAgentToolRounds, 200)
    assert.deepEqual(await settings.freezeExecution(executionId, '2026-08-13T02:03:00.000Z'), frozen)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 主与专项 execution 创建时原子冻结 settings snapshot', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const events = createAgentEventRepository(pool)
  const migrationPool = createPool(migrationUrl!)
  const analysisId = 'settings-snapshot-all-sessions'
  try {
    await settings.restoreDefaults('2026-08-13T02:04:00.000Z')
    await settings.save({ mainAgentToolRounds: 101 }, '2026-08-13T02:05:00.000Z')
    await events.createResearch({
      analysisId,
      sessionId: 'settings-snapshot-main',
      executionId: 'settings-snapshot-main-execution',
      symbol: 'SNAPALL',
      status: 'queued',
      operationId: 'create-main',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:06:00.000Z',
    })
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-main-execution'))?.values.mainAgentToolRounds,
      101,
    )

    await settings.save({ specialistAgentToolRounds: 202 }, '2026-08-13T02:07:00.000Z')
    await events.createSession({
      id: 'settings-snapshot-specialist',
      analysisId,
      executionId: 'settings-snapshot-specialist-execution',
      status: 'queued',
      operationId: 'create-specialist',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:08:00.000Z',
    })
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-specialist-execution'))?.values.specialistAgentToolRounds,
      202,
    )
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-main-execution'))?.values.specialistAgentToolRounds,
      20,
    )

    await migrationPool.query('REVOKE INSERT ON execution_settings_snapshots FROM vibe_invest_app')
    await assert.rejects(events.createSession({
      id: 'settings-snapshot-rollback',
      analysisId,
      executionId: 'settings-snapshot-rollback-execution',
      status: 'queued',
      operationId: 'create-rollback',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:09:00.000Z',
    }), /permission denied/)
    assert.equal(await events.getSession('settings-snapshot-rollback'), null)
    assert.equal(await settings.getExecutionSnapshot('settings-snapshot-rollback-execution'), null)
  } finally {
    await migrationPool.query('GRANT INSERT ON execution_settings_snapshots TO vibe_invest_app')
    await removeResearchFixture(pool, analysisId)
    await migrationPool.end()
    await pool.end()
  }
})

test('真实 PostgreSQL 原子创建主 Session、execution generation、初始 segment、Runtime Context 与 settings snapshot', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const settings = createRuntimeSettingsRepository(pool)
  const analysisId = `lifecycle-${crypto.randomUUID()}`
  const sessionId = `session-${crypto.randomUUID()}`
  const executionId = `execution-${crypto.randomUUID()}`
  const symbol = `L${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const createdAt = '2026-08-13T03:00:00.000Z'
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: {
        type: 'runtime_context', status: 'planning', executionId, generation: 1,
        waitReason: { kind: 'database', target: '首次研究初始化', startedAt: createdAt },
      },
      createdAt,
    })
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.id, sessionId)
    assert.equal(lifecycle?.execution.id, executionId)
    assert.equal(lifecycle?.execution.generation, 1)
    assert.equal(lifecycle?.segments[0]?.ordinal, 1)
    assert.equal(lifecycle?.events[0]?.type, 'runtime_context')
    assert.equal(lifecycle?.waitReason?.target, '首次研究初始化')
    assert.equal((await settings.getExecutionSnapshot(executionId))?.executionId, executionId)

    await assert.rejects(pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`active-${crypto.randomUUID()}`, sessionId, createdAt],
    ), /duplicate key value/)

    await events.append({
      sessionId, executionId, operationId: 'budget-transition',
      event: { type: 'status', status: 'budget_exhausted', terminal: false },
      projection: { status: 'budget_exhausted', executionStatus: 'budget_exhausted' },
      createdAt: '2026-08-13T03:00:01.000Z',
    })
    await assert.rejects(pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`budget-active-${crypto.randomUUID()}`, sessionId, createdAt],
    ), /duplicate key value/)
    const duplicateWhileBudgetClosing = await events.createResearch({
      analysisId: `duplicate-budget-${crypto.randomUUID()}`,
      sessionId: `duplicate-budget-session-${crypto.randomUUID()}`,
      executionId: `duplicate-budget-execution-${crypto.randomUUID()}`,
      symbol,
      status: 'planning', analysisStatus: 'queued', operationId: 'duplicate-budget-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T03:00:01.500Z',
    })
    assert.equal(duplicateWhileBudgetClosing.created, false)
    assert.equal(duplicateWhileBudgetClosing.analysisId, analysisId)
    await events.append({
      sessionId, executionId, operationId: 'budget-terminal',
      event: { type: 'status', status: 'budget_exhausted', terminal: true },
      projection: { status: 'budget_exhausted', executionStatus: 'budget_exhausted' },
      createdAt: '2026-08-13T03:00:02.000Z',
    })
    await pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`budget-terminal-${crypto.randomUUID()}`, sessionId, createdAt],
    )
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 原子保存 Compaction 事件、usage 与链接的新 segment', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const analysisId = `compaction-${crypto.randomUUID()}`
  const sessionId = `compaction-session-${crypto.randomUUID()}`
  const executionId = `compaction-execution-${crypto.randomUUID()}`
  const initialSegmentId = `compaction-segment-${crypto.randomUUID()}`
  const nextSegmentId = `compaction-segment-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: initialSegmentId,
      symbol: `C${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'compaction-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-14T01:00:00.000Z',
    })
    const input = {
      id: `compaction-${crypto.randomUUID()}`, executionId, segmentId: nextSegmentId,
      operationId: 'compaction-success:1',
      event: {
        type: 'compaction', status: 'completed', attempt: 1,
        fromSegmentId: initialSegmentId, toSegmentId: nextSegmentId,
        contextTokens: 120_000, contextWindow: 128_000,
        reserveTokens: 16_384, keepRecentTokens: 20_000,
      },
      contextTokens: 120_000, contextWindow: 128_000,
      reserveTokens: 16_384, keepRecentTokens: 20_000, tokensAfter: 18_000,
      summary: {
        goal: '形成综合报告', decisions: ['启动消息专项'], reportVersions: [],
        specialistStatuses: [], factIds: ['fact:one'], unresolved: ['目标价输入缺失'],
        personalContext: { position: 'held' },
      },
      usage: { input: 1000, output: 100, totalTokens: 1100 },
      attempts: [{
        attempt: 1, status: 'completed' as const, durationMs: 250,
        usage: { input: 1000, output: 100, totalTokens: 1100 },
      }],
      createdAt: '2026-08-14T01:00:01.000Z',
    }
    const committed = await events.commitCompaction(input)
    assert.equal(committed.created, true)
    const replayed = await events.commitCompaction(input)
    assert.equal(replayed.created, false)
    await assert.rejects(events.commitCompaction({
      ...input, contextTokens: input.contextTokens + 1,
    }), /agent_operation_conflict/)
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.deepEqual(lifecycle?.segments.map(({ id, ordinal, parentSegmentId }) => ({
      id, ordinal, parentSegmentId,
    })), [
      { id: initialSegmentId, ordinal: 1, parentSegmentId: null },
      { id: nextSegmentId, ordinal: 2, parentSegmentId: initialSegmentId },
    ])
    assert.equal(lifecycle?.events.at(-1)?.type, 'compaction')
    assert.deepEqual(lifecycle?.compactions.at(-1)?.summary, input.summary)
    assert.equal(lifecycle?.compactionAttempts.at(-1)?.usage.totalTokens, 1100)
    const failedInput = {
      id: `failed-compaction-${crypto.randomUUID()}`, executionId,
      operationId: 'compaction-failed:1',
      event: { type: 'compaction', status: 'failed', attempts: 1 },
      attempts: [{ attempt: 1, status: 'failed' as const, durationMs: 10, usage: null }],
      createdAt: '2026-08-14T01:00:02.000Z',
    }
    await events.failCompaction(failedInput)
    assert.equal((await events.failCompaction(failedInput)).created, false)
    await assert.rejects(events.failCompaction({
      ...failedInput, createdAt: '2026-08-14T01:00:03.000Z',
    }), /agent_operation_conflict/)
    const row = await pool.query<{
      summary_json: Record<string, unknown>; usage_json: Record<string, unknown>
    }>('SELECT summary_json, usage_json FROM agent_compactions WHERE id = $1', [input.id])
    assert.deepEqual(row.rows[0]?.summary_json, input.summary)
    assert.deepEqual(row.rows[0]?.usage_json, input.usage)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL tree fence 原子封存进行中的 Compaction attempt 为 cancelled', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `compaction-cancel-${crypto.randomUUID()}`
  const sessionId = `compaction-cancel-session-${crypto.randomUUID()}`
  const executionId = `compaction-cancel-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol: `X${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context' }, createdAt: '2026-08-14T02:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'compaction-cancel',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T02:00:00.100Z',
    })
    const requestId = `execution:${executionId}:main:compaction:1:attempt:1`
    await projections.recordModelRequest({
      id: requestId, executionId, projectionId: projection.id, turnIndex: 1,
      createdAt: '2026-08-14T02:00:01.000Z',
    })
    await events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `fence-${crypto.randomUUID()}`,
      operationId: 'compaction-cancel-stopping',
      event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T02:00:02.250Z',
    })
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.deepEqual(lifecycle?.compactionAttempts.map((attempt) => ({
      id: attempt.compactionId, attempt: attempt.attempt, status: attempt.status,
      durationMs: attempt.durationMs, usage: attempt.usage,
    })), [{
      id: requestId.replace(/:attempt:1$/, ''), attempt: 1,
      status: 'cancelled', durationMs: 1250, usage: null,
    }])
    await assert.rejects(events.recordCompactionAttempt({
      id: requestId.replace(/:attempt:1$/, ''), executionId, attempt: 1,
      status: 'cancelled', durationMs: 1250, usage: null,
      createdAt: '2026-08-14T02:00:02.250Z',
    }), /agent_execution_fenced/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL tree fence 与启动中断分别封存模型 attempt 为 cancelled 和 outcome_unknown', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = `model-fence-${crypto.randomUUID()}`
  const sessionId = `model-fence-session-${crypto.randomUUID()}`
  const executionId = `model-fence-execution-${crypto.randomUUID()}`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol: `F${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context' }, createdAt: '2026-08-14T04:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'model-fence',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T04:00:00.100Z',
    })
    await projections.recordModelRequest({
      id: `${executionId}:model-attempt:1`, executionId, projectionId: projection.id,
      turnIndex: 1, createdAt: '2026-08-14T04:00:01.000Z',
    })
    await events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `fence-${crypto.randomUUID()}`,
      operationId: 'model-fence-stopping', event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T04:00:02.250Z',
    })
    const stopped = await events.primaryLifecycle(analysisId)
    assert.deepEqual(stopped?.modelAttempts.map(({ status, usageStatus, durationMs, usage }) => ({
      status, usageStatus, durationMs, usage,
    })), [{
      status: 'cancelled', usageStatus: 'unknown', durationMs: 1250,
      usage: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null },
    }])
    assert.equal(stopped?.tokenUsage.coverage, 0)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 手动恢复复用主 Session 并原子创建新 generation 与 segment', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const settings = createRuntimeSettingsRepository(pool)
  const analysisId = `resume-${crypto.randomUUID()}`
  const sessionId = `resume-session-${crypto.randomUUID()}`
  const oldExecutionId = `resume-old-${crypto.randomUUID()}`
  const newExecutionId = `resume-new-${crypto.randomUUID()}`
  const createdAt = '2026-08-13T03:30:00.000Z'
  try {
    await events.createResearch({
      analysisId, sessionId, executionId: oldExecutionId,
      symbol: `R${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'resume-initial',
      event: { type: 'runtime_context', executionId: oldExecutionId, generation: 1 }, createdAt,
    })
    await events.append({
      sessionId, executionId: oldExecutionId, operationId: 'resume-interrupted',
      event: { type: 'status', status: 'interrupted', terminal: true },
      projection: { status: 'interrupted', executionStatus: 'interrupted', terminal: true },
      createdAt: '2026-08-13T03:30:01.000Z',
    })
    const resumed = await events.resumeResearch({
      analysisId, executionId: newExecutionId, segmentId: `resume-segment-${crypto.randomUUID()}`,
      operationId: 'resume-manual', event: {
        type: 'runtime_resume', status: 'planning', resumed: true,
        previousExecutionId: oldExecutionId, executionId: newExecutionId, generation: 2,
      }, createdAt: '2026-08-13T03:30:02.000Z',
    })
    assert.equal(resumed.sessionId, sessionId)
    assert.equal(resumed.executionId, newExecutionId)
    assert.equal(resumed.generation, 2)
    assert.equal(resumed.created, true)
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.id, sessionId)
    assert.equal(lifecycle?.execution.id, newExecutionId)
    assert.equal(lifecycle?.execution.generation, 2)
    assert.deepEqual(lifecycle?.segments.map(({ ordinal }) => ordinal), [1, 2])
    assert.deepEqual(lifecycle?.events.at(-1), {
      sequence: 3, createdAt: '2026-08-13T03:30:02.000Z',
      type: 'runtime_resume', status: 'planning', resumed: true,
      previousExecutionId: oldExecutionId, executionId: newExecutionId, generation: 2,
    })
    assert.equal((await settings.getExecutionSnapshot(newExecutionId))?.executionId, newExecutionId)
    await assert.rejects(events.resumeResearch({
      analysisId, executionId: `resume-conflict-${crypto.randomUUID()}`,
      operationId: 'resume-again', event: { type: 'runtime_context', resumed: true },
      createdAt: '2026-08-13T03:30:03.000Z',
    }), /analysis_not_resumable/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL primaryLifecycle 在并发状态写入期间只返回同一事务快照', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const writer = createAgentEventRepository(pool)
  const analysisId = `snapshot-${crypto.randomUUID()}`
  const sessionId = `snapshot-session-${crypto.randomUUID()}`
  const createdAt = '2026-08-13T03:10:00.000Z'
  let executionRead!: () => void
  let continueRead!: () => void
  const executionWasRead = new Promise<void>((resolve) => { executionRead = resolve })
  const writeCompleted = new Promise<void>((resolve) => { continueRead = resolve })
  const wrappedPool = Object.create(pool) as Pool
  const poolQuery = pool.query.bind(pool)
  wrappedPool.query = (async (...args: Parameters<typeof poolQuery>) => {
    const sql = String(args[0])
    if (sql.includes('FROM agent_events')) {
      await executionWasRead
      await writeCompleted
    }
    const result = await poolQuery(...args)
    if (sql.includes('FROM agent_executions') && sql.includes('ORDER BY generation DESC')) {
      executionRead()
      await writeCompleted
    }
    return result
  }) as typeof pool.query
  wrappedPool.connect = (async () => {
    const client = await pool.connect()
    const query = client.query.bind(client)
    client.query = (async (...args: Parameters<typeof query>) => {
      const result = await query(...args)
      const sql = String(args[0])
      if (sql.includes('FROM agent_executions') && sql.includes('ORDER BY generation DESC')) {
        executionRead()
        await writeCompleted
      }
      return result
    }) as typeof client.query
    return client
  }) as typeof pool.connect
  const reader = createAgentEventRepository(wrappedPool)
  try {
    await writer.createResearch({
      analysisId, sessionId, executionId: `snapshot-execution-${crypto.randomUUID()}`,
      symbol: `S${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' }, createdAt,
    })
    const reading = reader.primaryLifecycle(analysisId)
    await executionWasRead
    await writer.append({
      sessionId, executionId: (await writer.getSession(sessionId))!.executionId,
      operationId: 'running-model',
      event: { type: 'status', status: 'running_model' },
      projection: { status: 'running_model', executionStatus: 'running_model' },
      createdAt: '2026-08-13T03:10:01.000Z',
    })
    continueRead()
    const lifecycle = await reading
    const lastStatus = lifecycle?.events.filter((event) => event.type === 'status').at(-1)?.status
      ?? lifecycle?.events.at(-1)?.status
    assert.equal(lifecycle?.execution.status, 'planning')
    assert.equal(lastStatus, 'planning')
  } finally {
    continueRead()
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL execution fence 先于既有 operationId 幂等判定', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const analysisId = `fence-replay-${crypto.randomUUID()}`
  const sessionId = `fence-replay-session-${crypto.randomUUID()}`
  const executionId = `fence-replay-execution-${crypto.randomUUID()}`
  const fenceExecutionId = `fence-replay-stop-${crypto.randomUUID()}`
  const createdAt = '2026-08-13T03:20:00.000Z'
  const operations = [
    { id: 'old-status', event: { type: 'status', status: 'running_tools' } },
    { id: 'old-tool-call', event: { type: 'tool_call', name: 'fetch_financial_context' } },
    { id: 'old-tool-result', event: { type: 'tool_result', name: 'fetch_financial_context', result: { facts: [] } } },
  ]
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `F${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' }, createdAt,
    })
    for (const operation of operations) await events.append({
      sessionId, executionId, operationId: operation.id, event: operation.event,
      createdAt: '2026-08-13T03:20:01.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'fence-hash',
      projectedTools: [{ name: 'fetch_financial_context' }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-13T03:20:01.000Z',
    })
    await projections.beginToolBatch({
      id: `${executionId}:batch`, executionId, projectionId: projection.id, turnIndex: 1,
      calls: [
        { toolCallId: `${executionId}:done`, toolName: 'fetch_financial_context', position: 1 },
        { toolCallId: `${executionId}:call`, toolName: 'fetch_financial_context', position: 2 },
      ],
      createdAt: '2026-08-13T03:20:01.000Z',
    })
    await projections.startToolCall({
      batchId: `${executionId}:batch`, executionId, toolCallId: `${executionId}:done`,
      startedAt: '2026-08-13T03:20:01.100Z', operationId: 'partial-call-start',
      eventPayload: {
        type: 'tool_call', name: 'fetch_financial_context', toolCallId: `${executionId}:done`,
        startedAt: '2026-08-13T03:20:01.100Z',
      },
    })
    await pool.query(
      `UPDATE tool_batch_calls SET status = 'completed', completed_at = $1,
         completion_order = 1, result_payload_json = $2
       WHERE batch_id = $3 AND tool_call_id = $4`,
      ['2026-08-13T03:20:01.500Z', JSON.stringify({
        toolCallId: `${executionId}:done`, result: { facts: [] }, isError: false,
      }), `${executionId}:batch`, `${executionId}:done`],
    )
    const stopped = await events.fenceForStopping({
      sessionId, executionId, fenceExecutionId, operationId: 'current-stopping',
      event: { type: 'status', status: 'stopping' }, createdAt: '2026-08-13T03:20:02.000Z',
    })
    assert.equal((await projections.replay(executionId)).toolBatches[0]?.status, 'cancelled')
    assert.deepEqual(stopped.cancelledToolEvents.map(({ payload }) => payload.type),
      ['tool_call', 'tool_result'])
    assert.deepEqual((stopped.cancelledToolEvents[1]?.payload as { name?: string }).name,
      'fetch_financial_context')
    assert.deepEqual(stopped.cancelledToolEvents[0]?.payload, {
      type: 'tool_call', name: 'fetch_financial_context', toolCallId: `${executionId}:call`,
      input: {}, startedAt: null, notStarted: true,
      operationId: `${executionId}:batch:cancelled-call:${executionId}:call`,
    })
    assert.equal(stopped.cancelledToolEvents[1]?.payload.startedAt, null)
    assert.equal(stopped.cancelledToolEvents[1]?.payload.notStarted, true)
    assert.equal(stopped.cancelledToolEvents[1]?.payload.completionOrder, 2)
    assert.deepEqual((await projections.replay(executionId)).toolBatches[0]?.results
      .map(({ toolCallId, completionOrder }) => ({ toolCallId, completionOrder })), [
      { toolCallId: `${executionId}:done`, completionOrder: 1 },
      { toolCallId: `${executionId}:call`, completionOrder: 2 },
    ])
    assert.deepEqual(await events.fenceForStopping({
      sessionId, executionId, fenceExecutionId, operationId: 'current-stopping',
      event: { type: 'status', status: 'stopping' }, createdAt: '2026-08-13T03:20:02.000Z',
    }), stopped)
    const before = await events.list(sessionId, 0)
    const lifecycleBefore = await events.primaryLifecycle(analysisId)

    for (const operation of operations) await assert.rejects(events.append({
      sessionId, executionId, operationId: operation.id, event: operation.event,
      createdAt: '2026-08-13T03:20:03.000Z',
    }), /agent_execution_fenced/)
    const currentReplay = await events.append({
      sessionId, executionId: fenceExecutionId, operationId: 'current-stopping',
      event: { type: 'status', status: 'stopping' }, createdAt: '2026-08-13T03:20:03.000Z',
    })
    assert.equal(currentReplay.created, false)
    assert.deepEqual(await events.list(sessionId, 0), before)
    assert.deepEqual(await events.primaryLifecycle(analysisId), lifecycleBefore)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL settings snapshot 失败时不残留 Session、execution、segment 或事件', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const appPool = createPool(applicationUrl!)
  const migrationPool = createPool(migrationUrl!)
  const events = createAgentEventRepository(appPool)
  const analysisId = `rollback-${crypto.randomUUID()}`
  const sessionId = `rollback-session-${crypto.randomUUID()}`
  try {
    await migrationPool.query('REVOKE INSERT ON execution_settings_snapshots FROM vibe_invest_app')
    await assert.rejects(events.createResearch({
      analysisId, sessionId, executionId: `rollback-execution-${crypto.randomUUID()}`,
      symbol: `R${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T03:10:00.000Z',
    }), /permission denied/)
    assert.equal(await events.getSession(sessionId), null)
    assert.equal(await createAnalysisRepository(appPool).get(analysisId), null)
  } finally {
    await migrationPool.query('GRANT INSERT ON execution_settings_snapshots TO vibe_invest_app')
    await migrationPool.end()
    await appPool.end()
  }
})

test('真实 PostgreSQL 停止主 Session 时原子 fence 整棵专项树', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const suffix = crypto.randomUUID()
  const analysisId = `tree-fence-${suffix}`
  const mainSessionId = `${analysisId}:main`
  const mainExecutionId = `${mainSessionId}:execution`
  const specialistSessionId = `${analysisId}:news`
  const specialistExecutionId = `${specialistSessionId}:execution`
  try {
    await events.createResearch({
      analysisId, sessionId: mainSessionId, executionId: mainExecutionId,
      symbol: `T${suffix.slice(0, 8)}`, status: 'running', operationId: 'main-created',
      event: { type: 'status', status: 'running' }, createdAt: '2026-08-14T01:00:00.000Z',
    })
    await events.createSpecialistSession({
      id: specialistSessionId, analysisId, domain: 'news', executionId: specialistExecutionId,
      status: 'running_tools', operationId: 'news-created',
      event: { type: 'specialist_context', domain: 'news' },
      createdAt: '2026-08-14T01:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId: specialistExecutionId, role: 'news', stage: 'research',
      schemaHash: 'tree-fence-news', projectedTools: [{ name: 'search_news_candidates' }],
      visibleToolNames: ['search_news_candidates'], reasons: { stage: 'research' },
      createdAt: '2026-08-14T01:00:01.000Z',
    })
    await projections.beginToolBatch({
      id: `${specialistExecutionId}:batch`, executionId: specialistExecutionId,
      projectionId: projection.id, turnIndex: 1, calls: [{
        toolCallId: 'news-call', toolName: 'search_news_candidates', position: 1,
      }], createdAt: '2026-08-14T01:00:01.000Z',
    })

    const stopped = await events.fenceForStopping({
      sessionId: mainSessionId, executionId: mainExecutionId,
      fenceExecutionId: `${mainExecutionId}:stopping`, operationId: 'tree-stopping',
      event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T01:00:02.000Z',
    })

    assert.equal(stopped.fencedSessions.length, 2)
    assert.deepEqual(new Set(stopped.fencedSessions.map(({ sessionId }) => sessionId)),
      new Set([mainSessionId, specialistSessionId]))
    assert.equal((await events.sessionLifecycle(specialistSessionId))?.execution.status, 'stopping')
    assert.equal((await projections.replay(specialistExecutionId)).toolBatches[0]?.status, 'cancelled')
    await assert.rejects(events.append({
      sessionId: specialistSessionId, executionId: specialistExecutionId,
      operationId: 'late-specialist-result', event: { type: 'status', status: 'partial' },
      createdAt: '2026-08-14T01:00:03.000Z',
    }), /agent_execution_fenced/)
    await assert.rejects(events.createSpecialistSession({
      id: `${analysisId}:late-technical`, analysisId, domain: 'technical',
      executionId: `${analysisId}:late-technical:execution`, status: 'planning',
      operationId: 'late-technical-created',
      event: { type: 'specialist_context', domain: 'technical' },
      createdAt: '2026-08-14T01:00:03.000Z',
    }), /analysis_not_active/)
    assert.deepEqual(await events.createSpecialistSession({
      id: `${analysisId}:news-replay`, analysisId, domain: 'news',
      executionId: specialistExecutionId, status: 'running_tools', operationId: 'news-created',
      event: { type: 'specialist_context', domain: 'news' },
      createdAt: '2026-08-14T01:00:00.000Z',
    }), { sessionId: specialistSessionId, executionId: specialistExecutionId, created: false })
    assert.equal((await events.listSessions(analysisId)).length, 2)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 树级 fence 与并发专项创建按 analysis 行锁串行化', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const blocker = await pool.connect()
  const suffix = crypto.randomUUID()
  const analysisId = `tree-fence-race-${suffix}`
  const sessionId = `${analysisId}:main`
  const executionId = `${sessionId}:execution`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `R${suffix.slice(0, 8)}`,
      status: 'running', operationId: 'main-created',
      event: { type: 'status', status: 'running' }, createdAt: '2026-08-14T02:00:00.000Z',
    })
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [analysisId])
    let fenceSettled = false
    const fencing = events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `${executionId}:stopping`,
      operationId: 'tree-race-stopping', event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T02:00:01.000Z',
    }).finally(() => { fenceSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(fenceSettled, false)
    let createSettled = false
    const creating = events.createSpecialistSession({
      id: `${analysisId}:news`, analysisId, domain: 'news',
      executionId: `${analysisId}:news:execution`, status: 'planning',
      operationId: 'racing-news-created',
      event: { type: 'specialist_context', domain: 'news' },
      createdAt: '2026-08-14T02:00:01.000Z',
    }).finally(() => { createSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(createSettled, false)
    await blocker.query('COMMIT')
    await fencing
    await assert.rejects(creating, /analysis_not_active/)
    assert.deepEqual((await events.listSessions(analysisId)).map(({ id }) => id), [sessionId])
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 树级 fence 与主 Session append 使用同一锁序', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const blocker = await pool.connect()
  const suffix = crypto.randomUUID()
  const analysisId = `tree-fence-append-${suffix}`
  const sessionId = `${analysisId}:main`
  const executionId = `${sessionId}:execution`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `A${suffix.slice(0, 8)}`,
      status: 'running', operationId: 'main-created',
      event: { type: 'status', status: 'running' }, createdAt: '2026-08-14T03:00:00.000Z',
    })
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [analysisId])
    const fencing = events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `${executionId}:stopping`,
      operationId: 'append-race-stopping', event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T03:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const appending = events.append({
      sessionId, executionId, operationId: 'late-main-progress',
      event: { type: 'status', status: 'running_tools' },
      projection: { status: 'running', executionStatus: 'running_tools' },
      createdAt: '2026-08-14T03:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await blocker.query('COMMIT')
    await fencing
    await assert.rejects(appending, /agent_execution_fenced/)
    assert.equal((await events.sessionLifecycle(sessionId))?.execution.status, 'stopping')
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 树级 fence 与带事实的 Tool Batch 完成使用同一锁序', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const blocker = await pool.connect()
  const suffix = crypto.randomUUID()
  const analysisId = `tree-fence-batch-${suffix}`
  const sessionId = `${analysisId}:main`
  const executionId = `${sessionId}:execution`
  const batchId = `${executionId}:batch`
  const factId = `${analysisId}:fact`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `B${suffix.slice(0, 8)}`,
      status: 'running', operationId: 'main-created',
      event: { type: 'status', status: 'running' }, createdAt: '2026-08-14T04:00:00.000Z',
    })
    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'batch-lock-order',
      projectedTools: [{ name: 'fetch_financial_context' }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' },
      createdAt: '2026-08-14T04:00:00.000Z',
    })
    await projections.beginToolBatch({
      id: batchId, executionId, projectionId: projection.id, turnIndex: 1,
      calls: [{ toolCallId: 'fact-call', toolName: 'fetch_financial_context', position: 1 }],
      createdAt: '2026-08-14T04:00:01.000Z',
    })
    await projections.startToolCall({
      batchId, executionId, toolCallId: 'fact-call', operationId: 'fact-call-start',
      eventPayload: { type: 'tool_call', name: 'fetch_financial_context' },
      startedAt: '2026-08-14T04:00:01.000Z',
    })
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [analysisId])
    const fencing = events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `${executionId}:stopping`,
      operationId: 'batch-race-stopping', event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T04:00:02.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const completing = projections.completeToolBatch({
      id: batchId, executionId, completedAt: '2026-08-14T04:00:02.000Z', results: [{
        toolCallId: 'fact-call', status: 'completed',
        startedAt: '2026-08-14T04:00:01.000Z', completedAt: '2026-08-14T04:00:02.000Z',
        completionOrder: 1, operationId: 'fact-call-result',
        resultPayload: { facts: [{ id: factId, type: 'quote' }] },
        eventPayload: {
          type: 'tool_result', name: 'fetch_financial_context',
          result: { facts: [{ id: factId, type: 'quote' }] },
        },
      }],
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await blocker.query('COMMIT')
    await fencing
    await assert.rejects(completing, /tool_batch_completion_conflict/)
    assert.equal((await projections.replay(executionId)).toolBatches[0]?.status, 'cancelled')
    const stored = await pool.query('SELECT fact_id FROM analysis_facts WHERE fact_id = $1', [factId])
    assert.equal(stored.rowCount, 0)
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 树级 fence 与无批次因果 Projection 使用同一锁序', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const blocker = await pool.connect()
  const suffix = crypto.randomUUID()
  const analysisId = `tree-fence-projection-${suffix}`
  const sessionId = `${analysisId}:main`
  const executionId = `${sessionId}:execution`
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `P${suffix.slice(0, 8)}`,
      status: 'running', operationId: 'main-created',
      event: { type: 'status', status: 'running' }, createdAt: '2026-08-14T05:00:00.000Z',
    })
    await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'projection-before-fence',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'research' },
      createdAt: '2026-08-14T05:00:00.000Z',
    })
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [analysisId])
    const fencing = events.fenceForStopping({
      sessionId, executionId, fenceExecutionId: `${executionId}:stopping`,
      operationId: 'projection-race-stopping', event: { type: 'status', status: 'stopping' },
      createdAt: '2026-08-14T05:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const advancing = projections.ensureVersion({
      executionId, role: 'main', stage: 'finalization', schemaHash: 'projection-after-fence',
      projectedTools: [], visibleToolNames: [], reasons: { stage: 'finalization' },
      causativeEvent: {
        operationId: 'runtime-turn-advanced',
        payload: { type: 'runtime_turn_advanced', stage: 'finalization' },
      }, createdAt: '2026-08-14T05:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await blocker.query('COMMIT')
    await fencing
    await assert.rejects(advancing, /agent_execution_fenced/)
    assert.equal((await projections.replay(executionId)).projections.length, 1)
    assert.equal((await events.list(sessionId, 0))
      .some(({ operationId }) => operationId === 'runtime-turn-advanced'), false)
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 并发保存 Runtime settings 不丢失不同字段更新', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  try {
    await settings.restoreDefaults('2026-08-13T02:10:00.000Z')
    await Promise.all([
      settings.save({ mainAgentToolRounds: 100 }, '2026-08-13T02:11:00.000Z'),
      settings.save({ modelRequestTimeoutMinutes: 60 }, '2026-08-13T02:12:00.000Z'),
    ])
    const current = await settings.current()
    assert.equal(current.values.mainAgentToolRounds, 100)
    assert.equal(current.values.modelRequestTimeoutMinutes, 60)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL save 与 restoreDefaults 共用写锁且不会复活旧设置', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const blocker = await pool.connect()
  try {
    await settings.restoreDefaults('2026-08-13T02:13:00.000Z')
    await settings.save({ modelRequestTimeoutMinutes: 60 }, '2026-08-13T02:14:00.000Z')
    await blocker.query('SELECT pg_advisory_lock($1)', [8_613_092])
    let saveSettled = false
    let restoreSettled = false
    const saving = settings.save(
      { mainAgentToolRounds: 100 }, '2026-08-13T02:15:00.000Z',
    ).finally(() => { saveSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const restoring = settings.restoreDefaults(
      '2026-08-13T02:16:00.000Z',
    ).finally(() => { restoreSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(saveSettled, false)
    assert.equal(restoreSettled, false)
    await blocker.query('SELECT pg_advisory_unlock($1)', [8_613_092])
    await Promise.all([saving, restoring])
    assert.deepEqual((await settings.current()).values, defaultRuntimeSettings)
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1)', [8_613_092])
    blocker.release()
    await pool.end()
  }
})

test('真实 PostgreSQL migration 幂等且 application role 没有 DDL 权限', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  await migrate(migrationUrl!)

  const pool = createPool(applicationUrl!)
  assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 24 })
  const privileges = await pool.query<{ can_create: boolean; can_temp: boolean }>(
    `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
            has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp`,
  )
  assert.deepEqual(privileges.rows, [{ can_create: false, can_temp: false }])
  await pool.query(
    `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (symbol) DO UPDATE SET quantity = excluded.quantity`,
    ['T01', '1.25', '2.50', '2026-08-13T00:00:00.000Z'],
  )
  const stored = await pool.query<{ quantity: string; average_cost: string }>(
    'SELECT quantity, average_cost FROM positions WHERE symbol = $1',
    ['T01'],
  )
  assert.deepEqual(stored.rows, [{ quantity: '1.25', average_cost: '2.50' }])
  await assert.rejects(
    pool.query('CREATE TABLE forbidden_by_application_role (id integer)'),
    /permission denied/,
  )
  await pool.end()
})

test('真实 PostgreSQL migration receipt 为空时按 max=0 升级', {
  skip: !migrationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(migrationUrl!)
  const suffix = crypto.randomUUID()
  const analysisId = `max-zero-analysis-${suffix}`
  const sessionId = `max-zero-session-${suffix}`
  const executionId = `max-zero-execution-${suffix}`
  const event = { type: 'tool_result', name: 'fetch_financial_context', result: { facts: [] } }
  await migrate(migrationUrl!)
  try {
    await pool.query(
      `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
       VALUES ($1, 'MAXZERO', 'completed', false, now(), now())`, [analysisId],
    )
    await pool.query(
      `INSERT INTO agent_sessions (id, analysis_id, is_primary, execution_id, status,
         latest_sequence, created_at, updated_at)
       VALUES ($1, $2, true, $3, 'completed', 1, now(), now())`,
      [sessionId, analysisId, executionId],
    )
    await pool.query(
      `INSERT INTO agent_executions (id, session_id, generation, status, terminal, created_at, updated_at)
       VALUES ($1, $2, 1, 'completed', true, now(), now())`, [executionId, sessionId],
    )
    await pool.query(
      `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
       VALUES ($1, 1, $2, $3, now())`,
      [sessionId, `execution:${executionId}:tool:legacy-call:result`, JSON.stringify(event)],
    )
    await pool.query('DELETE FROM product_schema_migrations')
    await migrate(migrationUrl!)
    assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 24 })
    assert.deepEqual((await pool.query<{ sequence: number; provenance: string }>(
      `SELECT sequence, provenance FROM tool_event_migration_provenance WHERE session_id = $1`,
      [sessionId],
    )).rows, [{ sequence: 1, provenance: 'pre_registry_v12' }])
    assert.deepEqual((await createAgentEventRepository(pool).list(sessionId, 0))[0]?.payload, event)
  } finally {
    await pool.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await pool.end()
  }
})

test('真实 PostgreSQL 拒绝未发布的 schema 13、14、15 候选状态', {
  skip: !migrationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(migrationUrl!)
  try {
    for (const version of [13, 14, 15]) {
      await pool.query('DELETE FROM product_schema_migrations WHERE version > $1', [version])
      await assert.rejects(
        migrate(migrationUrl!),
        new RegExp(`product_schema_intermediate_candidate_unsupported:${version}`),
      )
      assert.deepEqual((await pool.query<{ version: number }>(
        'SELECT max(version)::integer AS version FROM product_schema_migrations',
      )).rows, [{ version }])
      await pool.query(
        `INSERT INTO product_schema_migrations (version)
         SELECT generate_series($1, 20) ON CONFLICT (version) DO NOTHING`,
        [version + 1],
      )
    }
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 拒绝未来 schema 且不修改数据库', {
  skip: !migrationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(migrationUrl!)
  const fingerprint = async () => ({
    receipts: (await pool.query<{ version: number }>(
      'SELECT version FROM product_schema_migrations ORDER BY version',
    )).rows,
    provenanceTable: (await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.tool_event_migration_provenance')::text AS table_name`,
    )).rows,
    batchCallColumns: (await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tool_batch_calls'
       ORDER BY ordinal_position`,
    )).rows,
    batchCallConstraints: (await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'public.tool_batch_calls'::regclass ORDER BY conname`,
    )).rows,
    appCanSelectPositions: (await pool.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('vibe_invest_app', 'positions', 'SELECT') AS allowed`,
    )).rows,
  })
  try {
    await pool.query('DROP TABLE tool_event_migration_provenance')
    await pool.query('INSERT INTO product_schema_migrations (version) VALUES (25)')
    const before = await fingerprint()

    await assert.rejects(
      migrate(migrationUrl!),
      /product_schema_future_version_unsupported:25/,
    )

    assert.deepEqual(await fingerprint(), before)
  } finally {
    await pool.query('DELETE FROM product_schema_migrations WHERE version = 25')
    await migrate(migrationUrl!)
    await pool.end()
  }
})

test('真实 PostgreSQL v12 无 Tool Batch 的历史工具事件原样升级到 v24', {
  skip: !migrationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(migrationUrl!)
  const suffix = crypto.randomUUID()
  const analysisId = `v12-analysis-${suffix}`
  const sessionId = `v12-session-${suffix}`
  const executionId = `v12-execution-${suffix}`
  const callEvent = {
    type: 'tool_call', name: 'fetch_financial_context', input: { symbol: 'AAPL' },
  }
  const resultEvent = {
    type: 'tool_result', name: 'fetch_financial_context', result: { facts: [] }, isError: false,
  }
  try {
    await migrate(migrationUrl!)
    await pool.query(
      `DROP TABLE tool_event_migration_provenance, tool_batch_calls,
         tool_call_batches, model_requests, tool_projection_versions`,
    )
    await pool.query('DELETE FROM product_schema_migrations WHERE version > 12')
    await pool.query(
      `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
       VALUES ($1, 'V12LEGACY', 'completed', false, now(), now())`, [analysisId],
    )
    await pool.query(
      `INSERT INTO agent_sessions (id, analysis_id, is_primary, execution_id, status,
         latest_sequence, created_at, updated_at) VALUES ($1, $2, true, $3, 'completed', 2, now(), now())`,
      [sessionId, analysisId, executionId],
    )
    await pool.query(
      `INSERT INTO agent_executions (id, session_id, generation, status, terminal, created_at, updated_at)
       VALUES ($1, $2, 1, 'completed', true, now(), now())`, [executionId, sessionId],
    )
    await pool.query(
      `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at) VALUES
       ($1, 1, $2, $3, now()), ($1, 2, $4, $5, now())`,
      [sessionId, `execution:${executionId}:tool:legacy-call:call`, JSON.stringify(callEvent),
        `execution:${executionId}:tool:legacy-call:result`, JSON.stringify(resultEvent)],
    )

    await migrate(migrationUrl!)

    assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 24 })
    assert.deepEqual((await pool.query<{ sequence: number; provenance: string }>(
      `SELECT sequence, provenance FROM tool_event_migration_provenance
       WHERE session_id = $1 ORDER BY sequence`, [sessionId],
    )).rows, [
      { sequence: 1, provenance: 'pre_registry_v12' },
      { sequence: 2, provenance: 'pre_registry_v12' },
    ])
    await migrate(migrationUrl!)
    assert.deepEqual((await createAgentEventRepository(pool).list(sessionId, 0))
      .map(({ operationId, payload }) => ({ operationId, payload })), [
      { operationId: `execution:${executionId}:tool:legacy-call:call`, payload: callEvent },
      { operationId: `execution:${executionId}:tool:legacy-call:result`, payload: resultEvent },
    ])
  } finally {
    await pool.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await pool.end()
  }
})

test('真实 PostgreSQL 从 v5 升级会移除 Session 一对一约束并回填 primary', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  const migrationPool = createPool(migrationUrl!)
  const analysisId = 'schema-v5-upgrade-analysis'
  const oldSessionId = 'schema-v5-upgrade-main'
  try {
    await migrationPool.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await migrationPool.query('DROP INDEX IF EXISTS agent_sessions_one_primary_per_analysis')
    await migrationPool.query('ALTER TABLE agent_sessions DROP COLUMN IF EXISTS is_primary')
    await migrationPool.query('ALTER TABLE agent_sessions DROP COLUMN IF EXISTS execution_id')
    await migrationPool.query(
      'ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_analysis_id_key UNIQUE (analysis_id)',
    )
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version > 5')
    await migrationPool.query(
      `INSERT INTO analyses (id, symbol, status, created_at, updated_at)
       VALUES ($1, 'UPGRADE', 'interrupted', now(), now())`,
      [analysisId],
    )
    await migrationPool.query(
      `INSERT INTO agent_sessions (
         id, analysis_id, status, latest_sequence, created_at, updated_at
       ) VALUES ($1, $2, 'interrupted', 1, now(), now())`,
      [oldSessionId, analysisId],
    )
  } finally {
    await migrationPool.end()
  }

  await migrate(migrationUrl!)
  const applicationPool = createPool(applicationUrl!)
  const events = createAgentEventRepository(applicationPool)
  try {
    assert.equal((await events.findPrimarySession(analysisId))?.id, oldSessionId)
    await events.createSession({
      id: 'schema-v5-upgrade-specialist',
      analysisId,
      executionId: 'schema-v5-upgrade-specialist-execution',
      status: 'queued',
      operationId: 'create-upgraded-specialist',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T00:00:00.000Z',
    })
    assert.equal((await events.listSessions(analysisId)).length, 2)
  } finally {
    await applicationPool.end()
    const cleanup = createPool(migrationUrl!)
    await cleanup.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await cleanup.end()
  }
})

test('application role 的事务失败会回滚产品写入', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO positions (symbol, quantity, average_cost, updated_at) VALUES ($1, $2, $3, $4)',
      ['ROLLBACK', '3', '4', '2026-08-13T00:00:00.000Z'],
    )
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
  const result = await pool.query('SELECT symbol FROM positions WHERE symbol = $1', ['ROLLBACK'])
  assert.deepEqual(result.rows, [])
  await pool.end()
})

test('真实 PostgreSQL 持仓 DAO 完成 CRUD、现金和原子减仓', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  try {
    const portfolio = createPortfolioRepository(pool)
    await portfolio.remove('NVDA')
    await portfolio.setCash(500)
    await portfolio.save({ symbol: 'NVDA', quantity: 10.125, averageCost: 100.25 })
    assert.deepEqual((await portfolio.list()).find(({ symbol }) => symbol === 'NVDA'),
      { symbol: 'NVDA', quantity: 10.125, averageCost: 100.25 })
    assert.deepEqual(await portfolio.reduce('NVDA', 0.125, 125.5), {
      position: { symbol: 'NVDA', quantity: 10, averageCost: 100.25 },
      cash: 515.6875,
      proceeds: 15.6875,
      realizedProfitLoss: 3.15625,
    })
    assert.equal(await portfolio.cash(), 515.6875)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 研究 DAO 保存任务、事实、轨迹并安全删除', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const id = 'dao-analysis-test'
  try {
    await repository.removeResearch(id)
    const now = '2026-08-13T00:00:00.000Z'
    await repository.createOrReturn({ id, symbol: 'NVDA', status: 'queued', createdAt: now, updatedAt: now })
    await repository.saveFact(id, { id: 'dao-fact-test', type: 'quote', value: 100 })
    await repository.appendTrace(id, { type: 'status', status: 'queued' })
    await repository.saveSnapshot(id, { symbol: 'NVDA' })
    await repository.setStatus(id, 'completed', now, { report: { title: 'DAO 测试' } })
    await repository.saveSnapshot(id, { symbol: 'NVDA', refreshed: true })
    const research = await repository.research(id)
    assert.equal(research?.status, 'completed')
    assert.deepEqual(research?.snapshot, { symbol: 'NVDA' })
    assert.deepEqual(research?.report, { title: 'DAO 测试' })
    assert.equal(research?.reportCreatedAt, now)
    await repository.updateResearch(id, { note: '更新备注' }, '2026-08-20T00:00:00.000Z')
    assert.equal((await repository.research(id))?.reportCreatedAt, now)
    assert.deepEqual(research?.facts, [{ id: 'dao-fact-test', type: 'quote', value: 100 }])
    assert.deepEqual(research?.trace, [{ type: 'status', status: 'queued' }])
    assert.equal(await repository.removeResearch(id), true)
    assert.equal(await repository.get(id), null)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 硬删除完整研究树、保留共享事实并以 tombstone 拒绝复活', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const suffix = crypto.randomUUID()
  const analysisId = `hard-delete-${suffix}`
  const sharedAnalysisId = `hard-delete-shared-${suffix}`
  const sessionId = `${analysisId}:main`
  const specialistSessionId = `${analysisId}:news`
  const executionId = `${sessionId}:execution`
  const specialistExecutionId = `${specialistSessionId}:execution`
  const sharedFactId = `${analysisId}:shared-fact`
  const exclusiveFactId = `${analysisId}:exclusive-fact`
  const createdAt = '2026-08-14T14:00:00.000Z'
  try {
    await analyses.createOrReturn({
      id: sharedAnalysisId, symbol: `S${suffix.slice(0, 8)}`, status: 'completed',
      createdAt, updatedAt: createdAt,
    })
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `${sessionId}:segment:1`,
      symbol: `D${suffix.slice(0, 8)}`, status: 'planning', analysisStatus: 'running',
      operationId: 'hard-delete-runtime-context',
      event: { type: 'runtime_context', privateContext: '不得保留' }, createdAt,
    })
    await events.createSpecialistSession({
      id: specialistSessionId, analysisId, domain: 'news', executionId: specialistExecutionId,
      status: 'planning', operationId: 'hard-delete-news-context',
      event: { type: 'specialist_context', domain: 'news' }, createdAt,
    })
    await analyses.saveFact(analysisId, { id: sharedFactId, type: 'quote', value: 100 })
    await analyses.saveFact(sharedAnalysisId, { id: sharedFactId, type: 'quote', value: 100 })
    await analyses.saveFact(analysisId, { id: exclusiveFactId, type: 'quote', value: 101 })
    await analyses.appendTrace(analysisId, { type: 'runtime_context', privateContext: '不得保留' })
    await analyses.saveSnapshot(analysisId, { symbol: 'DELETE', privateContext: '不得保留' })

    const projection = await projections.ensureVersion({
      executionId, role: 'main', stage: 'research', schemaHash: 'hard-delete-tools',
      projectedTools: [{ name: 'fetch_financial_context' }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' }, createdAt,
    })
    await projections.recordModelRequest({
      id: `${executionId}:request:1`, executionId, projectionId: projection.id,
      turnIndex: 1, createdAt,
    })
    await projections.completeModelRequest({
      id: `${executionId}:request:1`, executionId, status: 'completed',
      usageStatus: 'complete',
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, total: 15 },
      completedAt: '2026-08-14T14:00:01.000Z',
    })
    const batchId = `${executionId}:batch:1`
    await projections.beginToolBatch({
      id: batchId, executionId, projectionId: projection.id, turnIndex: 1,
      calls: [{ toolCallId: 'hard-delete-call', toolName: 'fetch_financial_context', position: 1 }],
      createdAt,
    })
    await projections.startToolCall({
      batchId, executionId, toolCallId: 'hard-delete-call',
      operationId: 'hard-delete-call-start',
      eventPayload: { type: 'tool_call', name: 'fetch_financial_context' }, startedAt: createdAt,
    })
    await projections.completeToolBatch({
      id: batchId, executionId, completedAt: '2026-08-14T14:00:01.000Z', results: [{
        toolCallId: 'hard-delete-call', status: 'completed', startedAt: createdAt,
        completedAt: '2026-08-14T14:00:01.000Z', completionOrder: 1,
        resultPayload: { facts: [{ id: exclusiveFactId, type: 'quote', value: 101 }] },
        operationId: 'hard-delete-call-result',
        eventPayload: { type: 'tool_result', name: 'fetch_financial_context' },
      }],
    })
    await events.commitCompaction({
      id: `${executionId}:compaction:1`, executionId,
      segmentId: `${sessionId}:segment:2`, operationId: 'hard-delete-compaction',
      event: { type: 'compaction', status: 'completed' },
      contextTokens: 100, contextWindow: 1000, reserveTokens: 100,
      keepRecentTokens: 100, tokensAfter: 50,
      summary: { goal: '硬删除验证' }, usage: { totalTokens: 3 },
      attempts: [{ attempt: 1, status: 'completed', durationMs: 5, usage: { totalTokens: 3 } }],
      createdAt: '2026-08-14T14:00:02.000Z',
    })
    await assert.rejects(analyses.removeResearch(analysisId), /analysis_not_stopped/)
    assert.deepEqual((await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM analysis_deletion_tombstones WHERE analysis_id = $1',
      [analysisId],
    )).rows, [{ count: 0 }])
    await events.append({
      sessionId: specialistSessionId, executionId: specialistExecutionId,
      operationId: 'hard-delete-news-completed',
      event: { type: 'status', status: 'completed', terminal: true },
      projection: { status: 'completed', executionStatus: 'completed', terminal: true },
      createdAt: '2026-08-14T14:00:02.500Z',
    })
    const report = { kind: 'integrated', title: '待硬删除报告' }
    await events.append({
      sessionId, executionId, operationId: 'hard-delete-completed',
      event: { type: 'status', status: 'completed', terminal: true },
      projection: {
        status: 'completed', executionStatus: 'completed', terminal: true,
        report, snapshot: { symbol: 'DELETE', privateContext: '不得保留' },
        reportVersion: {
          id: `${executionId}:report:1`, kind: 'integrated', payloadHash: 'd'.repeat(64),
          report, snapshot: { symbol: 'DELETE', privateContext: '不得保留' },
        },
      },
      createdAt: '2026-08-14T14:00:03.000Z',
    })

    assert.equal(await analyses.removeResearch(analysisId), true)
    const counts = await pool.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::integer FROM analyses WHERE id = $1) AS analyses,
         (SELECT count(*)::integer FROM analysis_facts WHERE analysis_id = $1) AS facts,
         (SELECT count(*)::integer FROM analysis_trace WHERE analysis_id = $1) AS trace,
         (SELECT count(*)::integer FROM agent_sessions WHERE analysis_id = $1) AS sessions,
         (SELECT count(*)::integer FROM agent_executions WHERE id = ANY($2::text[])) AS executions,
         (SELECT count(*)::integer FROM conversation_segments WHERE session_id = ANY($3::text[])) AS segments,
         (SELECT count(*)::integer FROM agent_events WHERE session_id = ANY($3::text[])) AS events,
         (SELECT count(*)::integer FROM execution_settings_snapshots WHERE execution_id = ANY($2::text[])) AS settings,
         (SELECT count(*)::integer FROM tool_projection_versions WHERE execution_id = ANY($2::text[])) AS projections,
         (SELECT count(*)::integer FROM model_requests WHERE execution_id = ANY($2::text[])) AS requests,
         (SELECT count(*)::integer FROM tool_call_batches WHERE execution_id = ANY($2::text[])) AS batches,
         (SELECT count(*)::integer FROM tool_batch_calls WHERE batch_id = $4) AS calls,
         (SELECT count(*)::integer FROM agent_compactions WHERE session_id = ANY($3::text[])) AS compactions,
         (SELECT count(*)::integer FROM agent_compaction_attempts WHERE session_id = ANY($3::text[])) AS attempts,
         (SELECT count(*)::integer FROM report_versions WHERE analysis_id = $1) AS reports,
         (SELECT count(*)::integer FROM analysis_deletion_tombstones WHERE analysis_id = $1) AS tombstones`,
      [analysisId, [executionId, specialistExecutionId], [sessionId, specialistSessionId], batchId],
    )
    assert.deepEqual(counts.rows[0], {
      analyses: 0, facts: 0, trace: 0, sessions: 0, executions: 0, segments: 0, events: 0,
      settings: 0, projections: 0, requests: 0, batches: 0, calls: 0,
      compactions: 0, attempts: 0,
      reports: 0, tombstones: 1,
    })
    assert.deepEqual((await pool.query<{ id: string }>(
      'SELECT id FROM atomic_facts WHERE id = ANY($1::text[]) ORDER BY id',
      [[sharedFactId, exclusiveFactId]],
    )).rows, [{ id: sharedFactId }])
    await assert.rejects(
      pool.query('DELETE FROM analysis_deletion_tombstones WHERE analysis_id = $1', [analysisId]),
      /permission denied/,
    )
    await assert.rejects(events.append({
      sessionId, executionId, operationId: 'hard-delete-late-write',
      event: { type: 'model_event' }, createdAt: '2026-08-14T14:00:04.000Z',
    }), /agent_execution_fenced|agent_session_not_found/)
    await assert.rejects(events.createResearch({
      analysisId, sessionId: `${sessionId}:recreated`, executionId: `${executionId}:recreated`,
      symbol: `D${suffix.slice(0, 8)}`, status: 'planning',
      operationId: 'hard-delete-recreated', event: { type: 'runtime_context' }, createdAt,
    }), /analysis_deleted/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await removeResearchFixture(pool, sharedAnalysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL v9 按报告完成事件回填 reportCreatedAt 且无事件时回退更新时间', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  const migrationPool = createPool(migrationUrl!)
  const applicationPool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(applicationPool)
  const eventTime = '2026-08-10T03:00:00.000Z'
  const fallbackTime = '2026-08-11T04:00:00.000Z'
  try {
    await migrationPool.query(`
      INSERT INTO analyses (
        id, symbol, status, created_at, updated_at, report_json, report_created_at
      ) VALUES
        ('report-created-at-event', 'RCAEVENT', 'completed', '2026-08-01T00:00:00Z',
         '2026-08-12T00:00:00Z', '{"title":"事件报告"}', NULL),
        ('report-created-at-fallback', 'RCAFALLBACK', 'completed', '2026-08-01T00:00:00Z',
         $1, '{"title":"回退报告"}', NULL)
      ON CONFLICT (id) DO UPDATE SET report_created_at = NULL
    `, [fallbackTime])
    await migrationPool.query(`
      INSERT INTO agent_sessions (
        id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
      ) VALUES (
        'report-created-at-session', 'report-created-at-event', true,
        'report-created-at-execution', 'completed', 1, '2026-08-01T00:00:00Z', $1::timestamptz
      ) ON CONFLICT (id) DO NOTHING
    `, [eventTime])
    await migrationPool.query(`
      INSERT INTO agent_events (
        session_id, sequence, operation_id, payload_json, created_at
      ) VALUES (
        'report-created-at-session', 1, 'report-created-at-completed',
        '{"type":"status","status":"completed"}', $1::timestamptz
      ) ON CONFLICT (session_id, operation_id) DO NOTHING
    `, [eventTime])

    await migrate(migrationUrl!)

    assert.equal((await repository.get('report-created-at-event'))?.reportCreatedAt, eventTime)
    assert.equal((await repository.get('report-created-at-fallback'))?.reportCreatedAt, fallbackTime)
  } finally {
    await migrationPool.query(
      `DELETE FROM analyses WHERE id IN ('report-created-at-event', 'report-created-at-fallback')`,
    )
    await applicationPool.end()
    await migrationPool.end()
  }
})

test('真实 PostgreSQL 并发创建同一标的只产生一个首次研究', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const symbol = 'CONCURRENT-CREATE'
  try {
    await pool.query('DELETE FROM analyses WHERE symbol = $1', [symbol])
    const now = '2026-08-13T00:00:00.000Z'
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      repository.createOrReturn({
        id: `concurrent-create-${index}`, symbol, status: 'queued', createdAt: now, updatedAt: now,
      })
    )))
    assert.equal(new Set(results.map(({ analysisId }) => analysisId)).size, 1)
    assert.equal(results.filter(({ created }) => created).length, 1)
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM analyses
       WHERE symbol = $1 AND status IN ('queued', 'running')`, [symbol],
    )
    assert.equal(rows.rows[0]?.count, 1)
  } finally {
    await pool.query('DELETE FROM analyses WHERE symbol = $1', [symbol])
    await pool.end()
  }
})

test('真实 PostgreSQL 并发队列 claim 每个任务只会被领取一次', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const prefix = 'concurrent-claim-'
  try {
    await pool.query('DELETE FROM analyses WHERE id LIKE $1', [`${prefix}%`])
    const now = '2026-08-13T00:00:00.000Z'
    for (let index = 0; index < 8; index += 1) {
      await repository.createOrReturn({
        id: `${prefix}${index}`, symbol: `CLAIM-${index}`, status: 'queued', createdAt: now, updatedAt: now,
      })
    }
    const claimed = await Promise.all(Array.from({ length: 24 }, () => repository.claimNextQueued(now)))
    const ids = claimed.filter((id): id is string => Boolean(id))
    assert.equal(ids.length, 8)
    assert.equal(new Set(ids).size, 8)
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM analyses
       WHERE id LIKE $1 AND status = 'running'`, [`${prefix}%`],
    )
    assert.equal(rows.rows[0]?.count, 8)
  } finally {
    await pool.query('DELETE FROM analyses WHERE id LIKE $1', [`${prefix}%`])
    await pool.end()
  }
})

test('真实 PostgreSQL 并发追加轨迹无丢失且 sequence 严格连续', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const id = 'concurrent-trace'
  try {
    await repository.removeResearch(id)
    const now = '2026-08-13T00:00:00.000Z'
    await repository.createOrReturn({ id, symbol: 'TRACE', status: 'queued', createdAt: now, updatedAt: now })
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      repository.appendTrace(id, { type: 'concurrent', index })
    )))
    const rows = await pool.query<{ sequence: number }>(
      'SELECT sequence FROM analysis_trace WHERE analysis_id = $1 ORDER BY sequence', [id],
    )
    assert.deepEqual(rows.rows.map(({ sequence }) => sequence), Array.from({ length: 40 }, (_, index) => index + 1))
  } finally {
    await repository.removeResearch(id)
    await pool.end()
  }
})

test('真实 PostgreSQL Agent Session 事件 sequence 严格递增且 operationId 幂等', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const sessionId = 'agent-event-ledger-session'
  try {
    await removeResearchFixture(pool, sessionId)
    const now = '2026-08-13T00:00:00.000Z'
    const created = await events.createResearch({
      analysisId: sessionId,
      sessionId,
      executionId: 'ledger-execution',
      symbol: 'LEDGER',
      status: 'queued',
      operationId: 'create-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })
    assert.deepEqual({ analysisId: created.analysisId, created: created.created }, {
      analysisId: sessionId, created: true,
    })
    const concurrent = await Promise.all(Array.from({ length: 40 }, (_, index) => (
      events.append({
        sessionId, executionId: 'ledger-execution',
        operationId: `trace-${index}`,
        event: { type: 'trace', index },
        createdAt: now,
      })
    )))
    const first = await events.append({
      sessionId,
      executionId: 'ledger-execution',
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const replay = await events.append({
      sessionId, executionId: 'ledger-execution',
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const concurrentReplay = await Promise.all(Array.from({ length: 20 }, () => events.append({
      sessionId, executionId: 'ledger-execution',
      operationId: 'one-concurrent-operation',
      event: { type: 'trace', value: 'only-once' },
      createdAt: now,
    })))

    assert.equal(new Set(concurrent.map(({ sequence }) => sequence)).size, 40)
    assert.equal(replay.sequence, first.sequence)
    assert.equal(replay.created, false)
    assert.equal(new Set(concurrentReplay.map(({ sequence }) => sequence)).size, 1)
    assert.equal(concurrentReplay.filter(({ created }) => created).length, 1)
    assert.deepEqual((await events.list(sessionId, 0)).map(({ sequence }) => sequence),
      Array.from({ length: 43 }, (_, index) => index + 1))
    assert.equal((await events.getSession(sessionId))?.status, 'completed')
    assert.equal((await analyses.get(sessionId))?.status, 'completed')
    await assert.rejects(
      pool.query(
        'UPDATE agent_events SET operation_id = $1 WHERE session_id = $2 AND sequence = 1',
        ['forbidden-update', sessionId],
      ),
      /permission denied/,
    )
  } finally {
    await removeResearchFixture(pool, sessionId)
    await pool.end()
  }
})

test('真实 PostgreSQL 仅为通过校验的报告原子生成不可变版本', {
  skip: !applicationUrl || !migrationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const migrationPool = createPool(migrationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const analysisId = `report-version-${crypto.randomUUID()}`
  const sessionId = `report-version-session-${crypto.randomUUID()}`
  const executionId = `report-version-execution-${crypto.randomUUID()}`
  const now = '2026-08-13T08:00:00.000Z'
  const payloadHash = 'a'.repeat(64)
  const report = { kind: 'integrated', title: '可追溯的综合报告' }
  const snapshot = { portfolioContext: { position: { symbol: 'NVDA', quantity: 10 } } }
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `R${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', operationId: 'create-report-session',
      event: { type: 'runtime_context' }, createdAt: now,
    })
    await events.append({
      sessionId, executionId, operationId: 'reject-candidate',
      event: {
        type: 'tool_result', name: 'submit_analysis_report', isError: true,
        result: { error: 'report_validation_failed', candidatePayloadHash: 'b'.repeat(64) },
      },
      createdAt: now,
    })
    assert.deepEqual(await events.listReportVersions(analysisId), [])

    const completed = {
      sessionId, executionId, operationId: 'complete-with-report',
      event: { type: 'status', status: 'completed', terminal: true },
      projection: {
        status: 'completed', executionStatus: 'completed' as const, terminal: true,
        report, snapshot,
        reportVersion: {
          id: `${executionId}:report`, kind: 'integrated' as const,
          payloadHash, report, snapshot,
        },
      },
      createdAt: now,
    }
    await events.append(completed)
    await events.append(completed)

    assert.deepEqual(await events.listReportVersions(analysisId), [{
      id: `${executionId}:report`, analysisId, sessionId, executionId, version: 1,
      kind: 'integrated', payloadHash, report, snapshot, createdAt: now,
    }])

    await migrationPool.query(
      'UPDATE report_versions SET snapshot_json = NULL WHERE analysis_id = $1', [analysisId],
    )
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version >= 23')
    await migrate(migrationUrl!)
    assert.deepEqual((await events.listReportVersions(analysisId))[0]?.snapshot, snapshot)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
    await migrationPool.end()
  }
})

test('真实 PostgreSQL 原子创建主 Agent 追问 execution 并按消息 ID 幂等重放', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const suffix = crypto.randomUUID()
  const analysisId = `follow-up-${suffix}`
  const sessionId = `${analysisId}:main`
  const firstExecutionId = `${sessionId}:execution:1`
  const followUpExecutionId = `${sessionId}:message:message-1`
  const operationId = `${sessionId}:message:message-1`
  const createdAt = '2026-08-14T12:00:00.000Z'
  const followUpAt = '2026-08-14T12:01:00.000Z'
  const report = { kind: 'integrated', title: 'V1' }
  const event = {
    type: 'runtime_follow_up', status: 'planning', executionId: followUpExecutionId,
    baseReportVersion: 1, messageId: 'message-1', message: '报告还有效吗？', updateReport: false,
  }
  try {
    await events.createResearch({
      analysisId, sessionId, executionId: firstExecutionId,
      symbol: `F${suffix.slice(0, 8)}`, status: 'planning',
      operationId: 'create-follow-up-research', event: { type: 'runtime_context' }, createdAt,
    })
    await events.append({
      sessionId, executionId: firstExecutionId, operationId: 'complete-v1',
      event: { type: 'status', status: 'completed', terminal: true },
      projection: {
        status: 'completed', executionStatus: 'completed', terminal: true, report,
        reportVersion: {
          id: `${firstExecutionId}:report`, kind: 'integrated', payloadHash: 'c'.repeat(64), report,
        },
      },
      createdAt,
    })
    const input = {
      analysisId, executionId: followUpExecutionId,
      segmentId: `${followUpExecutionId}:segment`, baseReportVersion: 1,
      operationId, event, createdAt: followUpAt,
    }
    const created = await Promise.all([
      events.createFollowUpExecution(input), events.createFollowUpExecution(input),
    ])
    assert.equal(created.filter(({ created }) => created).length, 1)
    assert.deepEqual(new Set(created.map(({ generation }) => generation)), new Set([2]))
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.id, sessionId)
    assert.equal(lifecycle?.execution.id, followUpExecutionId)
    assert.equal(lifecycle?.execution.generation, 2)
    assert.equal(lifecycle?.segments.length, 2)
    assert.equal(lifecycle?.events.filter((candidate) => (
      (candidate as Record<string, unknown>).type === 'runtime_follow_up'
    )).length, 1)
    await assert.rejects(events.createFollowUpExecution({
      ...input, event: { ...event, message: '不得改写同一消息 ID' },
    }), /agent_operation_conflict/)
    await events.append({
      sessionId, executionId: followUpExecutionId, operationId: 'follow-up-stopped',
      event: { type: 'status', status: 'stopped', terminal: true },
      projection: { status: 'stopped', executionStatus: 'stopped', terminal: true },
      createdAt: '2026-08-14T12:02:00.000Z',
    })
    await assert.rejects(events.createFollowUpExecution({
      ...input,
      executionId: `${sessionId}:message:message-2`,
      segmentId: `${sessionId}:message:message-2:segment`,
      operationId: `${sessionId}:message:message-2`,
      event: {
        ...event, executionId: `${sessionId}:message:message-2`,
        messageId: 'message-2', message: '停止后必须先恢复',
      },
      createdAt: '2026-08-14T12:03:00.000Z',
    }), /analysis_resume_required/)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 事件与 Session 读取投影在投影失败时一起回滚', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const sessionId = 'agent-event-rollback-session'
  try {
    await analyses.removeResearch(sessionId)
    const now = '2026-08-13T00:00:00.000Z'
    await events.createResearch({
      analysisId: sessionId,
      sessionId, executionId: 'rollback-event-execution',
      executionId: 'rollback-event-execution',
      symbol: 'ROLLBACK-EVENT',
      status: 'queued',
      operationId: 'create-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })

    await assert.rejects(events.append({
      sessionId, executionId: 'rollback-event-execution',
      operationId: 'invalid-projection',
      event: { type: 'status', status: '', at: now },
      projection: { status: '', facts: [{ id: 'rolled-back-fact', type: 'quote', value: 100 }] },
      createdAt: now,
    }))

    assert.equal((await events.getSession(sessionId))?.latestSequence, 1)
    assert.deepEqual(await events.list(sessionId, 1), [])
    assert.equal((await analyses.get(sessionId))?.status, 'queued')
    assert.deepEqual((await analyses.research(sessionId))?.facts, [])
  } finally {
    await removeResearchFixture(pool, sessionId)
    await pool.end()
  }
})

test('真实 PostgreSQL 同一 analysis 可拥有多个独立 Agent Session 账本', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const analysisId = 'multi-session-analysis'
  try {
    await analyses.removeResearch(analysisId)
    const now = '2026-08-13T00:00:00.000Z'
    const created = await events.createResearch({
      analysisId,
      sessionId: 'multi-session-main',
      executionId: 'multi-session-main-execution',
      symbol: 'MULTI',
      status: 'queued',
      operationId: 'create-main-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })
    assert.equal(created.sessionId, 'multi-session-main')
    for (const sessionId of ['multi-session-news', 'multi-session-fundamental', 'multi-session-technical']) {
      await events.createSession({
        id: sessionId,
        analysisId,
        executionId: `${sessionId}-execution`,
        status: 'queued',
        operationId: `create:${sessionId}`,
        event: { type: 'status', status: 'queued', at: now },
        createdAt: now,
      })
      await events.append({
        sessionId, executionId: `${sessionId}-execution`,
        operationId: `run:${sessionId}`,
        event: { type: 'status', status: 'running', at: now },
        projection: { status: 'running' },
        createdAt: now,
      })
    }

    const sessions = await events.listSessions(analysisId)
    assert.deepEqual(sessions.map(({ id }) => id), [
      'multi-session-main', 'multi-session-fundamental', 'multi-session-news', 'multi-session-technical',
    ])
    for (const session of sessions) {
      assert.deepEqual((await events.list(session.id, 0)).map(({ sequence }) => sequence),
        session.isPrimary ? [1] : [1, 2])
    }
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 每个研究只允许一个长期消息面 Session', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const analysisId = `unique-news-${crypto.randomUUID()}`
  const now = '2026-08-13T13:00:00.000Z'
  try {
    await events.createResearch({
      analysisId, sessionId: `${analysisId}:main`, executionId: `${analysisId}:main:execution`,
      symbol: `N${crypto.randomUUID().slice(0, 8)}`, status: 'planning',
      operationId: 'create-main', event: { type: 'runtime_context' }, createdAt: now,
    })
    const first = await events.createSpecialistSession({
      id: `${analysisId}:news`, analysisId, domain: 'news',
      executionId: `${analysisId}:news:execution`, status: 'planning',
      operationId: 'create-news', event: { type: 'specialist_context', domain: 'news' }, createdAt: now,
    })
    const replay = await events.createSpecialistSession({
      id: `${analysisId}:news:duplicate`, analysisId, domain: 'news',
      executionId: `${analysisId}:news:duplicate:execution`, status: 'planning',
      operationId: 'create-news-duplicate', event: { type: 'specialist_context', domain: 'news' }, createdAt: now,
    })

    assert.equal(first.created, true)
    assert.equal(replay.created, false)
    assert.equal(replay.sessionId, first.sessionId)
    await events.append({
      sessionId: first.sessionId, executionId: first.executionId,
      operationId: 'complete-news', event: { type: 'status', status: 'completed' },
      projection: { status: 'completed', executionStatus: 'completed', terminal: true },
      createdAt: '2026-08-13T13:00:01.000Z',
    })
    const followUp = await events.createSpecialistSession({
      id: `${analysisId}:news:another-session`, analysisId, domain: 'news',
      executionId: `${analysisId}:news:follow-up-execution`, status: 'planning',
      operationId: 'follow-up-news', event: {
        type: 'specialist_context', domain: 'news', researchQuestion: '后续问题',
      }, createdAt: '2026-08-13T13:00:02.000Z',
    })

    assert.equal(followUp.created, true)
    assert.equal(followUp.sessionId, first.sessionId)
    assert.equal(followUp.executionId, `${analysisId}:news:follow-up-execution`)
    const lifecycle = await events.sessionLifecycle(first.sessionId)
    assert.equal(lifecycle?.execution.generation, 2)
    assert.equal(lifecycle?.segments.length, 2)
    await events.append({
      sessionId: followUp.sessionId, executionId: followUp.executionId,
      operationId: 'complete-follow-up-news', event: { type: 'status', status: 'completed' },
      projection: { status: 'completed', executionStatus: 'completed', terminal: true },
      createdAt: '2026-08-13T13:00:03.000Z',
    })
    const replayedFollowUp = await events.createSpecialistSession({
      id: `${analysisId}:news:replayed-session`, analysisId, domain: 'news',
      executionId: followUp.executionId, status: 'planning',
      operationId: 'follow-up-news', event: {
        type: 'specialist_context', domain: 'news', researchQuestion: '后续问题',
      }, createdAt: '2026-08-13T13:00:02.000Z',
    })
    assert.equal(replayedFollowUp.created, false)
    assert.equal((await events.sessionLifecycle(first.sessionId))?.execution.generation, 2)
    assert.equal((await events.listSessions(analysisId)).filter(({ isPrimary }) => !isPrimary).length, 1)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 启动恢复在一个事务内中断全部活跃 Session', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analysisId = 'interrupt-all-analysis'
  const now = '2026-08-13T00:00:00.000Z'
  try {
    await analyses.removeResearch(analysisId)
    await events.createResearch({
      analysisId,
      sessionId: 'interrupt-all-main',
      executionId: 'interrupt-all-main-execution',
      symbol: 'INTERRUPT-ALL',
      status: 'running',
      operationId: 'execution:main:running',
      event: { type: 'status', status: 'running', at: now },
      createdAt: now,
    })
    await events.createSession({
      id: 'interrupt-all-specialist',
      analysisId,
      executionId: 'interrupt-all-specialist-execution',
      status: 'running',
      operationId: 'execution:specialist:running',
      event: { type: 'status', status: 'running', at: now },
      createdAt: now,
    })
    for (const executionId of ['interrupt-all-main-execution', 'interrupt-all-specialist-execution']) {
      const projection = await projections.ensureVersion({
        executionId, role: executionId.includes('main') ? 'main' : 'fundamental',
        stage: 'research', schemaHash: `${executionId}:hash`,
        projectedTools: [{ name: 'fetch_financial_context' }],
        visibleToolNames: ['fetch_financial_context'],
        reasons: { stage: 'research' }, createdAt: now,
      })
      await projections.beginToolBatch({
        id: `${executionId}:batch`, executionId, projectionId: projection.id, turnIndex: 1,
        calls: [{ toolCallId: `${executionId}:call`, toolName: 'fetch_financial_context', position: 1 }],
        createdAt: now,
      })
    }

    const interrupted = await events.interruptActiveSessions('2026-08-13T00:00:01.000Z')

    assert.deepEqual(interrupted.map(({ sessionId, sequence, operationId, cancelledToolEvents }) => ({
      sessionId, sequence, operationId, cancelledTypes: cancelledToolEvents.map(({ payload }) => payload.type),
    })), [{
      sessionId: 'interrupt-all-main', sequence: 4,
      operationId: 'startup:interrupt:interrupt-all-main:4',
      cancelledTypes: ['tool_call', 'tool_result'],
    }, {
      sessionId: 'interrupt-all-specialist', sequence: 4,
      operationId: 'startup:interrupt:interrupt-all-specialist:4',
      cancelledTypes: ['tool_call', 'tool_result'],
    }])
    assert.deepEqual(await events.interruptActiveSessions('2026-08-13T00:00:01.000Z'), [])
    assert.deepEqual((await events.listSessions(analysisId)).map(({ status }) => status),
      ['interrupted', 'interrupted'])
    assert.deepEqual((await Promise.all([
      events.primaryLifecycle(analysisId),
      pool.query<{ status: string }>(
        `SELECT status FROM agent_executions WHERE session_id = 'interrupt-all-specialist'`,
      ).then((result) => result.rows[0]),
    ])).map((value) => value?.status), ['interrupted', 'interrupted'])
    assert.equal((await analyses.get(analysisId))?.status, 'interrupted')
    assert.deepEqual(await Promise.all([
      projections.replay('interrupt-all-main-execution'),
      projections.replay('interrupt-all-specialist-execution'),
    ]).then((replays) => replays.map((replay) => replay.toolBatches[0]?.status)),
    ['cancelled', 'cancelled'])
    const replacement = await events.createResearch({
      analysisId: 'interrupt-all-replacement',
      sessionId: 'interrupt-all-replacement-session',
      executionId: 'interrupt-all-replacement-execution',
      symbol: 'INTERRUPT-ALL', status: 'planning', analysisStatus: 'queued',
      operationId: 'interrupt-all-replacement-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T00:00:02.000Z',
    })
    assert.equal(replacement.created, true)
    await removeResearchFixture(pool, replacement.analysisId)
  } finally {
    await removeResearchFixture(pool, analysisId)
    await pool.end()
  }
})
