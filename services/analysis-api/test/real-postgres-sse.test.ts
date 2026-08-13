import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'

import {
  checkSchema,
  createAgentEventRepository,
  createAnalysisRepository,
  createPool,
  createPortfolioRepository,
  createRuntimeSettingsRepository,
  createToolProjectionRepository,
} from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import { createPiModel, type ModelEvent } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test('真实 PostgreSQL 与真实 HTTP SSE 断线后先 catch-up 再继续 live', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const eventRepository = createAgentEventRepository(pool)
  let writeMissedEvent: (() => void) | undefined
  let finishModel: (() => void) | undefined
  const missedEventMayWrite = new Promise<void>((resolve) => { writeMissedEvent = resolve })
  const modelMayFinish = new Promise<void>((resolve) => { finishModel = resolve })
  let runtimeExecutionId: string | undefined
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: eventRepository,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: {
      async *analyze(input): AsyncGenerator<ModelEvent> {
        runtimeExecutionId = input.executionId
        const replayedOperationId = `execution:${input.executionId}:model-attempt:1:event:1:text`
        yield { type: 'text_delta', text: 'first-connection', operationId: replayedOperationId }
        yield { type: 'text_delta', text: 'first-connection', operationId: replayedOperationId }
        await missedEventMayWrite
        yield { type: 'text_delta', text: 'persisted-while-disconnected' }
        await modelMayFinish
        yield { type: 'completed', report: {
          title: 'SSE 回放测试', marketState: '数据不足', trend: '未知', drivers: [],
          supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
          invalidationConditions: [], valuation: null, personalImpact: null,
          conditionalSuggestion: null, limitations: ['测试数据为空'],
        } }
      },
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'PGSSE' }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  try {
    const persistedSession = await eventRepository.getSession(created.sessionId)
    const firstController = new AbortController()
    const firstResponse = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
      signal: firstController.signal,
    })
    const first = await readThrough(firstResponse, 'first-connection')
    assert.equal(runtimeExecutionId, persistedSession?.executionId)
    const lastEventId = [...first.matchAll(/id: ([^\n]+)/g)].at(-1)?.[1]
    assert.match(lastEventId ?? '', new RegExp(`^${created.sessionId}:\\d+$`))
    firstController.abort()

    writeMissedEvent!()
    await waitForPersistedEvent(eventRepository, created.sessionId, 'persisted-while-disconnected')

    const secondResponse = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
      headers: { 'last-event-id': lastEventId! },
    })
    const secondReader = secondResponse.body!.getReader()
    const catchUp = await readThroughReader(secondReader, 'persisted-while-disconnected')
    assert.doesNotMatch(catchUp, /first-connection/)
    assert.match(catchUp, /persisted-while-disconnected/)

    finishModel!()
    const live = await readThroughReader(secondReader, 'event: partial')
    assert.match(live, /event: model_completed/)
    assert.match(live, /event: partial/)
    const cursorSequence = Number(lastEventId!.split(':').at(-1))
    const ids = [...`${catchUp}${live}`.matchAll(/id: ([^\n]+)/g)].map((match) => match[1]!)
    assert.ok(ids.every((id) => id.startsWith(`${created.sessionId}:`)
      && Number(id.split(':').at(-1)) > cursorSequence))
    const replayed = (await eventRepository.list(created.sessionId, 0)).filter(({ operationId }) => (
      operationId.endsWith(':model-attempt:1:event:1:text')
    ))
    assert.equal(replayed.length, 1)
  } finally {
    writeMissedEvent!()
    finishModel!()
    await app.close()
  }
})

test('真实 PostgreSQL 重启恢复在 API、Session ledger 与 SSE 中一致终止', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const analysisId = 'restart-event-analysis'
  const sessionId = 'restart-event-session'
  await analyses.removeResearch(analysisId)
  const beforeRestart = '2026-08-13T00:00:00.000Z'
  await events.createResearch({
    analysisId,
    sessionId,
    executionId: 'before-restart',
    symbol: 'RESTART-EVENT',
    status: 'running',
    operationId: 'execution:before-restart:running',
    event: { type: 'status', status: 'running', at: beforeRestart },
    createdAt: beforeRestart,
  })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: analyses,
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: { async *analyze(): AsyncGenerator<ModelEvent> { return } },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const status = await fetch(`${baseUrl}/api/analyses/${analysisId}`).then((response) => response.json())
    assert.equal(status.status, 'interrupted')
    assert.equal((await events.getSession(sessionId))?.status, 'interrupted')
    const ledger = await events.list(sessionId, 0)
    assert.deepEqual(ledger.map(({ sequence }) => sequence), [1, 2])
    assert.equal(ledger[1]?.operationId, `startup:interrupt:${sessionId}:2`)
    const response = await fetch(`${baseUrl}/api/agent-sessions/${sessionId}/events`, {
      headers: { 'last-event-id': `${sessionId}:1` },
    })
    const replay = await response.text()
    assert.match(replay, new RegExp(`id: ${sessionId}:2`))
    assert.match(replay, /event: interrupted/)
    assert.doesNotMatch(replay, /event: running/)
  } finally {
    await app.close()
  }
})

test('真实 PostgreSQL 取消在 PG、HTTP 与 SSE reconnect 统一为 stopping → stopped', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  let modelStarted!: () => void
  const started = new Promise<void>((resolve) => { modelStarted = resolve })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: {
      async *analyze(input): AsyncGenerator<ModelEvent> {
        modelStarted()
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'cancelled' }
      },
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const symbol = `C${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  const originalExecutionId = (await events.getSession(created.sessionId))!.executionId
  try {
    await started
    const before = await events.list(created.sessionId, 0)
    const cursor = `${created.sessionId}:${before.at(-1)!.sequence}`
    const cancelled = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelled.status, 202)
    await waitForAgentStatus(events, created.sessionId, 'stopped')

    const status = await fetch(`${baseUrl}/api/analyses/${created.analysisId}`).then((response) => response.json())
    const research = await fetch(`${baseUrl}/api/research/${created.analysisId}`).then((response) => response.json())
    assert.equal(status.status, 'stopped')
    assert.equal(research.status, 'stopped')
    assert.equal(research.mainAgent.status, 'stopped')
    assert.equal((await events.getSession(created.sessionId))?.status, 'stopped')
    const execution = await pool.query<{ status: string; wait_reason_json: unknown }>(
      `SELECT status, wait_reason_json FROM agent_executions
       WHERE session_id = $1 ORDER BY generation DESC LIMIT 1`,
      [created.sessionId],
    )
    assert.deepEqual(execution.rows[0], { status: 'stopped', wait_reason_json: null })

    const replay = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
      headers: { 'last-event-id': cursor },
    }).then((response) => response.text())
    assert.match(replay, /event: stopping/)
    assert.match(replay, /event: stopped/)
    assert.doesNotMatch(replay, /event: cancelled/)

    const beforeLateWrite = await events.list(created.sessionId, 0)
    const fenced = await events.getSession(created.sessionId)
    assert.notEqual(fenced?.executionId, originalExecutionId)
    const generations = await pool.query<{ generation: number }>(
      'SELECT generation FROM agent_executions WHERE session_id = $1 ORDER BY generation',
      [created.sessionId],
    )
    assert.deepEqual(generations.rows.map(({ generation }) => generation), [1, 2])
    await assert.rejects(events.append({
      sessionId: created.sessionId, executionId: originalExecutionId,
      operationId: `execution:${originalExecutionId}:late-tool-result`,
      event: { type: 'tool_result', name: 'fetch_financial_context', result: { facts: [] } },
      createdAt: new Date().toISOString(),
    }), /agent_execution_fenced/)
    await assert.rejects(events.append({
      sessionId: created.sessionId, executionId: originalExecutionId,
      operationId: `execution:${created.analysisId}:late-completed`,
      event: { type: 'status', status: 'completed', terminal: true },
      projection: { status: 'completed', executionStatus: 'completed', terminal: true },
      createdAt: new Date().toISOString(),
    }), /agent_execution_fenced/)
    assert.equal((await events.list(created.sessionId, 0)).length, beforeLateWrite.length)
    assert.equal((await events.getSession(created.sessionId))?.status, 'stopped')
    assert.equal((await fetch(`${baseUrl}/api/analyses/${created.analysisId}`)
      .then((response) => response.json())).status, 'stopped')
  } finally {
    await app.close()
  }
})

test('生产 Pi 经 HTTP、SSE 与真实 PostgreSQL 留存工具及预算收口状态序列', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const settings = createRuntimeSettingsRepository(pool)
  const previousSettings = await settings.current()
  await settings.save({ mainAgentToolRounds: 1 }, new Date().toISOString())
  const symbol = `B${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const report = {
    title: '预算收口序列', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['预算达到上限'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(
      fauxToolCall('fetch_financial_context', { symbol }, { id: 'budget-context' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      fauxToolCall('submit_analysis_report', report, { id: 'budget-report' }),
      { stopReason: 'toolUse' },
    ),
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: events,
    runtimeSettingsRepository: settings,
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (requested) => ({ symbol: requested, gaps: [], facts: [] }),
    model,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  try {
    await waitForAgentStatus(events, created.sessionId, 'partial')
    const ledger = await events.list(created.sessionId, 0)
    const statuses = ledger.flatMap(({ payload }) => (
      payload.type === 'status' && typeof payload.status === 'string' ? [payload.status] : []
    ))
    assertSubsequence(statuses, [
      'planning', 'running_model', 'running_tools',
      'budget_exhausted', 'finalizing', 'running_tools', 'partial',
    ])
    const budget = ledger.find(({ payload }) => payload.status === 'budget_exhausted')
    assert.equal(budget?.payload.terminal, false)
    const finalizing = ledger.find(({ payload }) => payload.status === 'finalizing')
    assert.equal(typeof (finalizing?.payload.waitReason as { startedAt?: unknown })?.startedAt, 'string')
    const execution = await pool.query<{ status: string; terminal: boolean; wait_reason_json: unknown }>(
      'SELECT status, terminal, wait_reason_json FROM agent_executions WHERE session_id = $1',
      [created.sessionId],
    )
    assert.deepEqual(execution.rows[0], { status: 'partial', terminal: true, wait_reason_json: null })

    const research = await fetch(`${baseUrl}/api/research/${created.analysisId}`)
      .then((response) => response.json())
    assert.equal(research.mainAgent.status, 'partial')
    assertSubsequence(research.mainAgent.events.map((event: { status?: string }) => event.status), [
      'running_model', 'running_tools', 'budget_exhausted', 'finalizing', 'partial',
    ])
    const replay = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`)
      .then((response) => response.text())
    for (const status of ['running_model', 'running_tools', 'budget_exhausted', 'finalizing', 'partial']) {
      assert.match(replay, new RegExp(`event: ${status}`))
    }
    const toolRuntime = await fetch(
      `${baseUrl}/api/agent-sessions/${created.sessionId}/tool-runtime`,
    ).then((response) => response.json())
    assert.deepEqual(toolRuntime.modelRequests.map((request: { projectionVersion: number }) => (
      request.projectionVersion
    )), [1, 2])
    assert.deepEqual(toolRuntime.projections.map((projection: { visibleToolNames: string[] }) => (
      projection.visibleToolNames
    )), [[
      'fetch_financial_context', 'analyze_financials', 'submit_analysis_report',
    ], ['submit_analysis_report']])
    assert.equal(JSON.stringify(toolRuntime).includes('hidden_tool'), false)
    assert.equal(JSON.stringify(toolRuntime).includes('allowedStages'), false)
  } finally {
    await settings.save(previousSettings.values, new Date().toISOString())
    await app.close()
  }
})

test('Pi Runtime 使用持久 executionId 派生工具 operationId 且真实 PostgreSQL 重放幂等', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const callId = 'replayed-provider-call'
  const reportCallId = 'stable-report-call'
  const cancelledAfterReportCallId = 'cancelled-after-report-call'
  const report = {
    title: '稳定 operationId 测试', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['测试上下文为空'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([
      fauxToolCall('fetch_financial_context', { symbol: 'PGOPID' }, { id: callId }),
      fauxToolCall('fetch_financial_context', { symbol: 'PGOPID' }, { id: callId }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('submit_analysis_report', report, { id: reportCallId }),
      fauxToolCall('fetch_financial_context', { symbol: 'PGOPID' }, { id: cancelledAfterReportCallId }),
    ], { stopReason: 'toolUse' }),
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: analyses,
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'PGOPID' },
  })).json() as { analysisId: string; sessionId: string }
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'partial')
    const session = await events.getSession(created.sessionId)
    assert.ok(session)
    const ledger = await events.list(created.sessionId, 0)
    const toolPrefix = `execution:${session.executionId}:tool:${callId}:main-attempt:1`
    const duplicateToolPrefix = `${toolPrefix}:position:2`
    const firstToolPrefix = `${toolPrefix}:position:1`
    assert.equal(ledger.filter(({ operationId }) => operationId === `${firstToolPrefix}:call`).length, 1)
    assert.equal(ledger.filter(({ operationId }) => operationId === `${firstToolPrefix}:result`).length, 1)
    assert.equal(ledger.filter(({ operationId }) => operationId === `${duplicateToolPrefix}:call`).length, 1)
    assert.equal(ledger.filter(({ operationId }) => operationId === `${duplicateToolPrefix}:result`).length, 1)
    assert.deepEqual(ledger.filter(({ operationId }) => operationId.startsWith(toolPrefix))
      .map(({ operationId }) => operationId), [
      `${firstToolPrefix}:call`, `${duplicateToolPrefix}:call`,
      `${firstToolPrefix}:result`, `${duplicateToolPrefix}:result`,
    ])
    const reportPrefix = `execution:${session.executionId}:tool:${reportCallId}:main-attempt:2:position:1`
    const cancelledPrefix = `execution:${session.executionId}:tool:${cancelledAfterReportCallId}:main-attempt:2:position:2`
    const sealedBatch = ledger.filter(({ operationId }) => (
      operationId === `${reportPrefix}:call`
      || operationId === `${cancelledPrefix}:call`
      || operationId === `${reportPrefix}:result`
      || operationId === `${cancelledPrefix}:result`
      || operationId === `${reportPrefix}:report`
    ))
    assert.deepEqual(sealedBatch.map(({ operationId }) => operationId), [
      `${reportPrefix}:call`,
      `${cancelledPrefix}:call`,
      `${reportPrefix}:result`,
      `${cancelledPrefix}:result`,
      `${reportPrefix}:report`,
    ])
    assert.deepEqual(sealedBatch.slice(0, 4).map(({ payload }) => payload.type), [
      'tool_call', 'tool_call', 'tool_result', 'tool_result',
    ])
    assert.equal(sealedBatch[2]?.payload.isError, false)
    assert.equal(sealedBatch[3]?.payload.isError, true)
    assert.deepEqual(sealedBatch[3]?.payload, {
      type: 'tool_result', name: 'fetch_financial_context',
      result: { error: 'cancelled_after_report_submission', cancelled: true, facts: [] },
      isError: true,
      operationId: `${cancelledPrefix}:result`,
    })
  } finally {
    await app.close()
  }
})

test('主 Agent 校验失败与合法调用在下一轮前按原序封存到真实 PostgreSQL', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const unknownCallId = 'pg-main-unknown'
  const invalidCallId = 'pg-main-invalid'
  const validCallId = 'pg-main-valid'
  const reportCallId = 'pg-main-validation-report'
  let createdSessionId: string | undefined
  let providerObservedSealedLedger = false
  let validCalls = 0
  const report = {
    title: '主批次校验封存测试', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['测试上下文为空'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([
      fauxToolCall('hidden_main_tool', {}, { id: unknownCallId }),
      fauxToolCall('fetch_financial_context', { symbol: '' }, { id: invalidCallId }),
      fauxToolCall('fetch_financial_context', {}, { id: validCallId }),
    ], { stopReason: 'toolUse' }),
    async (context) => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const prefix = `execution:${session.executionId}:tool`
      const sealed = (await events.list(createdSessionId, 0)).filter(({ operationId }) => (
        operationId.startsWith(`${prefix}:${unknownCallId}:`)
        || operationId.startsWith(`${prefix}:${invalidCallId}:`)
        || operationId.startsWith(`${prefix}:${validCallId}:`)
      ))
      const runtimeIds = [unknownCallId, invalidCallId, validCallId]
        .map((id, index) => `${id}:main-attempt:1:position:${index + 1}`)
      assert.deepEqual(sealed.map(({ operationId }) => operationId), [
        ...runtimeIds.map((id) => `${prefix}:${id}:call`),
        ...runtimeIds.map((id) => `${prefix}:${id}:result`),
      ])
      assert.deepEqual(sealed.slice(3, 5).map(({ payload }) => payload), [
        {
          type: 'tool_result', name: 'hidden_main_tool',
          result: { error: 'tool_not_available', facts: [] }, isError: true,
          operationId: `${prefix}:${runtimeIds[0]}:result`,
        },
        {
          type: 'tool_result', name: 'fetch_financial_context',
          result: { error: 'invalid_tool_arguments', facts: [] }, isError: true,
          operationId: `${prefix}:${runtimeIds[1]}:result`,
        },
      ])
      assert.deepEqual(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? message.toolCallId : ''), [
        ...runtimeIds,
      ])
      providerObservedSealedLedger = true
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', report, { id: reportCallId }),
        { stopReason: 'toolUse' },
      )
    },
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: analyses,
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => {
      validCalls += 1
      return { symbol, gaps: [], facts: [] }
    },
    model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'PGMAIN' },
  })).json() as { analysisId: string; sessionId: string }
  createdSessionId = created.sessionId
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'partial')
    assert.equal(providerObservedSealedLedger, true)
    assert.equal(validCalls, 1)
  } finally {
    await app.close()
  }
})

test('主 Agent 跨 Turn 复用与空 call id 在真实 PostgreSQL 各自完整封存且重放幂等', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const reusedId = 'pg-cross-turn-reused'
  const reportCallId = 'pg-cross-turn-report'
  let createdSessionId: string | undefined
  let providerChecks = 0
  const report = {
    title: '跨 Turn operationId 测试', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['测试上下文为空'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(
      fauxToolCall('fetch_financial_context', {}, { id: reusedId }), { stopReason: 'toolUse' },
    ),
    async () => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const firstPrefix = `execution:${session.executionId}:tool:${reusedId}:main-attempt:1:position:1`
      assert.deepEqual((await events.list(createdSessionId, 0))
        .filter(({ operationId }) => operationId.startsWith(firstPrefix))
        .map(({ operationId }) => operationId), [`${firstPrefix}:call`, `${firstPrefix}:result`])
      providerChecks += 1
      return fauxAssistantMessage(
        fauxToolCall('fetch_financial_context', {}, { id: reusedId }), { stopReason: 'toolUse' },
      )
    },
    async () => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const prefix = `execution:${session.executionId}:tool:${reusedId}`
      assert.deepEqual((await events.list(createdSessionId, 0))
        .filter(({ operationId }) => operationId.startsWith(prefix))
        .map(({ operationId }) => operationId), [
        `${prefix}:main-attempt:1:position:1:call`,
        `${prefix}:main-attempt:1:position:1:result`,
        `${prefix}:main-attempt:2:position:1:call`,
        `${prefix}:main-attempt:2:position:1:result`,
      ])
      providerChecks += 1
      return fauxAssistantMessage(
        fauxToolCall('fetch_financial_context', {}, { id: '' }), { stopReason: 'toolUse' },
      )
    },
    async () => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const emptyPrefix = `execution:${session.executionId}:tool:missing:main-attempt:3:position:1`
      const ledger = await events.list(createdSessionId, 0)
      assert.deepEqual(ledger.filter(({ operationId }) => operationId.startsWith(emptyPrefix))
        .map(({ operationId }) => operationId), [`${emptyPrefix}:call`, `${emptyPrefix}:result`])
      const beforeReplay = ledger.length
      const replayed = await events.append({
        sessionId: createdSessionId, executionId: session.executionId,
        operationId: `${emptyPrefix}:result`,
        event: ledger.find(({ operationId }) => operationId === `${emptyPrefix}:result`)!.payload,
        createdAt: new Date().toISOString(),
      })
      assert.equal(replayed.created, false)
      assert.equal((await events.list(createdSessionId, 0)).length, beforeReplay)
      providerChecks += 1
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', report, { id: reportCallId }),
        { stopReason: 'toolUse' },
      )
    },
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: analyses,
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'PGCROSS' },
  })).json() as { analysisId: string; sessionId: string }
  createdSessionId = created.sessionId
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'partial')
    assert.equal(providerChecks, 3)
  } finally {
    await app.close()
  }
})

test('专项下一轮 provider 启动前已在真实 PostgreSQL 封存上一批工具事件', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const specialistEntryId = 'pg-specialist-entry'
  const unknownCallId = 'pg-specialist-unknown'
  const invalidCallId = 'pg-specialist-invalid'
  const newsCallId = 'pg-specialist-news'
  const indicatorCallId = 'pg-specialist-indicator'
  const reportCallId = 'pg-specialist-report'
  let createdSessionId: string | undefined
  let providerObservedSealedLedger = false
  const report = {
    title: '专项批次封存测试', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['测试上下文为空'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(
      fauxToolCall('analyze_financials', {}, { id: specialistEntryId }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([
      fauxToolCall('hidden_specialist_tool', {}, { id: unknownCallId }),
      fauxToolCall('search_news_by_keyword', { keyword: '' }, { id: invalidCallId }),
      fauxToolCall('search_news_by_keyword', {}, { id: newsCallId }),
      fauxToolCall('get_technical_indicators', {}, { id: indicatorCallId }),
    ], { stopReason: 'toolUse' }),
    async (context) => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const prefix = `execution:${session.executionId}:specialist-tool`
      const sealed = (await events.list(createdSessionId, 0)).filter(({ operationId }) => (
        operationId.startsWith(`${prefix}:${unknownCallId}:`)
        || operationId.startsWith(`${prefix}:${invalidCallId}:`)
        || operationId.startsWith(`${prefix}:${newsCallId}:`)
        || operationId.startsWith(`${prefix}:${indicatorCallId}:`)
      ))
      const runtimeIds = [unknownCallId, invalidCallId, newsCallId, indicatorCallId]
        .map((id, index) => `${id}:specialist-invocation:${encodeURIComponent(
          `${specialistEntryId}:main-attempt:1:position:1`,
        )}:attempt:1:position:${index + 1}`)
      assert.deepEqual(sealed.map(({ operationId }) => operationId), [
        ...runtimeIds.map((id) => `${prefix}:${id}:call`),
        ...runtimeIds.map((id) => `${prefix}:${id}:result`),
      ])
      assert.deepEqual(sealed.slice(4, 6).map(({ payload }) => payload), [
        {
          type: 'tool_result', name: 'hidden_specialist_tool',
          result: { error: 'tool_not_available', facts: [] }, isError: true,
          operationId: `${prefix}:${runtimeIds[0]}:result`,
        },
        {
          type: 'tool_result', name: 'search_news_by_keyword',
          result: { error: 'invalid_tool_arguments', facts: [] }, isError: true,
          operationId: `${prefix}:${runtimeIds[1]}:result`,
        },
      ])
      assert.deepEqual(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? message.toolCallId : ''), [
        ...runtimeIds,
      ])
      return fauxAssistantMessage(
        fauxToolCall('search_news_by_keyword', {}, { id: newsCallId }),
        { stopReason: 'toolUse' },
      )
    },
    async (context) => {
      assert.ok(createdSessionId)
      const session = await events.getSession(createdSessionId)
      assert.ok(session)
      const prefix = `execution:${session.executionId}:specialist-tool:${newsCallId}`
      const invocation = encodeURIComponent(`${specialistEntryId}:main-attempt:1:position:1`)
      assert.deepEqual((await events.list(createdSessionId, 0))
        .filter(({ operationId }) => operationId.startsWith(prefix))
        .map(({ operationId }) => operationId), [
        `${prefix}:specialist-invocation:${invocation}:attempt:1:position:3:call`,
        `${prefix}:specialist-invocation:${invocation}:attempt:1:position:3:result`,
        `${prefix}:specialist-invocation:${invocation}:attempt:2:position:1:call`,
        `${prefix}:specialist-invocation:${invocation}:attempt:2:position:1:result`,
      ])
      const resultIds = context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? message.toolCallId : '')
      assert.notEqual(resultIds.at(-2), resultIds.at(-1))
      providerObservedSealedLedger = true
      return fauxAssistantMessage('专项收口完成')
    },
    fauxAssistantMessage(
      fauxToolCall('submit_analysis_report', report, { id: reportCallId }),
      { stopReason: 'toolUse' },
    ),
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: analyses,
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [], financials: {} }),
    searchNews: async () => ({ facts: [] }),
    fetchTechnicalIndicators: async () => ({ facts: [] }),
    model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'PGSEAL' },
  })).json() as { analysisId: string; sessionId: string }
  createdSessionId = created.sessionId
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'partial')
    assert.equal(providerObservedSealedLedger, true)
    const statusEvents = (await events.list(created.sessionId, 0)).filter(
      ({ payload }) => payload.type === 'status',
    )
    assertSubsequence(statusEvents.map(({ payload }) => payload.status as string), [
      'running_tools', 'waiting_for_specialists', 'running_tools', 'running_model', 'partial',
    ])
    const waiting = statusEvents.find(({ payload }) => payload.status === 'waiting_for_specialists')
    assert.deepEqual(waiting?.payload.waitReason && {
      kind: (waiting.payload.waitReason as { kind: string }).kind,
      target: (waiting.payload.waitReason as { target: string }).target,
      startedAt: typeof (waiting.payload.waitReason as { startedAt: unknown }).startedAt,
    }, { kind: 'specialists', target: '财报专项分析', startedAt: 'string' })
    const research = (await app.inject({
      method: 'GET', url: `/api/research/${created.analysisId}`,
    })).json()
    assertSubsequence(research.mainAgent.events.map((event: { status?: string }) => event.status), [
      'waiting_for_specialists', 'running_tools', 'running_model', 'partial',
    ])
    const replay = (await app.inject({
      method: 'GET', url: `/api/agent-sessions/${created.sessionId}/events`,
    })).body
    assert.match(replay, /event: waiting_for_specialists/)
    assert.match(replay, /"target":"财报专项分析"/)
  } finally {
    await app.close()
  }
})

test('同一 execution 两次专项 invocation 在真实 PostgreSQL 各自封存且重放幂等', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const parentId = 'pg-specialist-parent-reused'
  const repeatedId = 'pg-specialist-child-reused'
  const report = {
    title: '多次专项命名空间测试', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: ['测试上下文为空'],
  }
  let createdSessionId: string | undefined
  let checks = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: parentId }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', {}, { id: repeatedId }),
      fauxToolCall('search_news_by_keyword', {}, { id: '' }),
    ], { stopReason: 'toolUse' }),
    async (context) => {
      assert.ok(createdSessionId)
      const ledger = await events.list(createdSessionId, 0)
      const sealed = ledger.filter(({ operationId }) => operationId.includes(':specialist-tool:'))
      assert.equal(sealed.length, 4)
      assert.equal(new Set(sealed.map(({ operationId }) => operationId)).size, 4)
      assert.equal(context.messages.filter(({ role }) => role === 'toolResult').length, 2)
      checks += 1
      return fauxAssistantMessage('第一次专项完成')
    },
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: parentId }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', {}, { id: repeatedId }),
      fauxToolCall('search_news_by_keyword', {}, { id: '' }),
    ], { stopReason: 'toolUse' }),
    async (context) => {
      assert.ok(createdSessionId)
      const ledger = await events.list(createdSessionId, 0)
      const sealed = ledger.filter(({ operationId }) => operationId.includes(':specialist-tool:'))
      assert.equal(sealed.length, 8)
      assert.equal(new Set(sealed.map(({ operationId }) => operationId)).size, 8)
      assert.equal(context.messages.filter(({ role }) => role === 'toolResult').length, 2)
      const replay = sealed[0]!
      const replayed = await events.append({
        sessionId: createdSessionId, executionId: (await events.getSession(createdSessionId))!.executionId,
        operationId: replay.operationId,
        event: replay.payload, createdAt: new Date().toISOString(),
      })
      assert.equal(replayed.created, false)
      assert.equal((await events.list(createdSessionId, 0)).filter(
        ({ operationId }) => operationId.includes(':specialist-tool:'),
      ).length, 8)
      checks += 1
      return fauxAssistantMessage('第二次专项完成')
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', report), { stopReason: 'toolUse' }),
  ] })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool), analysisRepository: analyses,
    agentEventRepository: events, runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [], financials: {} }),
    searchNews: async () => ({ facts: [] }), model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'PGMSP' },
  })).json() as { analysisId: string; sessionId: string }
  createdSessionId = created.sessionId
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'partial')
    assert.equal(checks, 2)
  } finally {
    await app.close()
  }
})

async function readThrough(response: Response, marker: string) {
  return readThroughReader(response.body!.getReader(), marker)
}

async function readThroughReader(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(marker)) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text
}

async function waitForPersistedEvent(
  repository: ReturnType<typeof createAgentEventRepository>,
  sessionId: string,
  text: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await repository.list(sessionId, 0)).some(({ payload }) => payload.text === text)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('agent_event_not_persisted')
}

async function waitForAgentStatus(
  repository: ReturnType<typeof createAgentEventRepository>, sessionId: string, expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await repository.getSession(sessionId))?.status === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`agent_status_not_reached:${expected}`)
}

async function waitForAnalysisStatus(
  app: ReturnType<typeof buildApp>, analysisId: string, expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}` })
    if (response.json().status === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`analysis_status_not_reached:${expected}`)
}

function assertSubsequence(actual: Array<string | undefined>, expected: string[]) {
  let position = 0
  for (const item of actual) if (item === expected[position]) position += 1
  assert.equal(position, expected.length, `missing sequence ${expected.join(' → ')} in ${actual.join(' → ')}`)
}
