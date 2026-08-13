import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
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
  migrate,
} from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import { createPiModel, type ModelEvent, type ToolRuntime } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL

function integratedReport<T extends Record<string, unknown>>(report: T) {
  return {
    kind: 'integrated' as const, availability: report.limitations instanceof Array
      && report.limitations.length ? 'partial' as const : 'available' as const,
    status: report.limitations instanceof Array && report.limitations.length
      ? 'partial' as const : 'completed' as const,
    gaps: [], ...report,
  }
}

test('真实 v12 历史 Tool 事件升级到 v18 后经 DAO、HTTP 与 SSE 原样读取', {
  skip: !databaseUrl || !migrationDatabaseUrl,
  concurrency: false,
}, async () => {
  const migrationPool = createPool(migrationDatabaseUrl!)
  const suffix = crypto.randomUUID()
  const analysisId = `v12-http-analysis-${suffix}`
  const sessionId = `v12-http-session-${suffix}`
  const executionId = `v12-http-execution-${suffix}`
  const callEvent = { type: 'tool_call', name: 'fetch_financial_context', input: { symbol: 'AAPL' } }
  const resultEvent = {
    type: 'tool_result', name: 'fetch_financial_context', result: { facts: [] }, isError: false,
  }
  await migrate(migrationDatabaseUrl!)
  try {
    await migrationPool.query(
      `DROP TABLE tool_event_migration_provenance, tool_batch_calls,
         tool_call_batches, model_requests, tool_projection_versions`,
    )
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version > 12')
    await migrationPool.query(
      `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
       VALUES ($1, 'V12HTTP', 'completed', false, now(), now())`, [analysisId],
    )
    await migrationPool.query(
      `INSERT INTO agent_sessions (id, analysis_id, is_primary, execution_id, status,
         latest_sequence, created_at, updated_at) VALUES ($1, $2, true, $3, 'completed', 2, now(), now())`,
      [sessionId, analysisId, executionId],
    )
    await migrationPool.query(
      `INSERT INTO agent_executions (id, session_id, generation, status, terminal, created_at, updated_at)
       VALUES ($1, $2, 1, 'completed', true, now(), now())`, [executionId, sessionId],
    )
    await migrationPool.query(
      `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at) VALUES
       ($1, 1, $2, $3, now()), ($1, 2, $4, $5, now())`,
      [sessionId, `execution:${executionId}:tool:legacy-call:call`, JSON.stringify(callEvent),
        `execution:${executionId}:tool:legacy-call:result`, JSON.stringify(resultEvent)],
    )

    await migrate(migrationDatabaseUrl!)

    const pool = createPool(databaseUrl!)
    const events = createAgentEventRepository(pool)
    const app = buildApp({
      productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
      portfolioRepository: createPortfolioRepository(pool),
      analysisRepository: createAnalysisRepository(pool),
      agentEventRepository: events,
      runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
      toolProjectionRepository: createToolProjectionRepository(pool),
      financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
      fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
      model: createPiModel({ fauxResponses: [] }),
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      assert.deepEqual((await events.list(sessionId, 0)).map(({ payload }) => payload),
        [callEvent, resultEvent])
      const research = await fetch(`${baseUrl}/api/research/${analysisId}`)
        .then((response) => response.json())
      assert.deepEqual(research.trace, [callEvent, resultEvent])
      const response = await fetch(`${baseUrl}/api/agent-sessions/${sessionId}/events`)
      const reader = response.body!.getReader()
      const sse = await readThroughReader(reader, 'event: tool_result')
      await reader.cancel()
      assert.match(sse, /event: tool_call/)
      assert.match(sse, /event: tool_result/)
      assert.doesNotMatch(sse, /toolCallId/)
    } finally {
      await app.close()
    }
  } finally {
    await migrationPool.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await migrationPool.end()
  }
})

test('真实 PostgreSQL 在模型槽等待取消时不留下 phantom model request', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const projections = createToolProjectionRepository(pool)
  const analyses = createAnalysisRepository(pool)
  const analysisId = `phantom-analysis-${crypto.randomUUID()}`
  const sessionId = `phantom-session-${crypto.randomUUID()}`
  const executionId = `phantom-execution-${crypto.randomUUID()}`
  const controller = new AbortController()
  let providerCalls = 0
  const toolRuntime: ToolRuntime = {
    async ensureProjection(input) {
      const projection = await projections.ensureVersion({
        executionId: input.executionId, role: input.role, stage: input.stage,
        schemaHash: JSON.stringify(input.tools), projectedTools: input.tools,
        visibleToolNames: input.tools.map(({ name }) => name),
        reasons: { role: input.role, stage: input.stage }, createdAt: input.createdAt,
      })
      return { id: projection.id, version: projection.version }
    },
    async recordModelRequest(input) {
      await projections.recordModelRequest({
        id: input.requestId, executionId: input.executionId, projectionId: input.projectionId,
        turnIndex: input.turnIndex, createdAt: input.createdAt,
      })
    },
    async beginModelRequest() { throw new Error('legacy_begin_model_request_not_allowed') },
    async beginToolBatch(input) { await projections.beginToolBatch(input) },
    async startToolCall(input) { await projections.startToolCall(input) },
    async completeToolBatch() { return {} },
  }
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, symbol: `P${crypto.randomUUID().slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' }, createdAt: new Date().toISOString(),
    })
    const model = createPiModel({ fauxResponses: [async () => {
      providerCalls += 1
      return fauxAssistantMessage('不应调用')
    }] })
    const running = (async () => {
      for await (const _event of model.analyze({
        executionId, runtimeSettings: (await createRuntimeSettingsRepository(pool).current()).values,
        symbol: 'PHANTOM', systemPrompt: 'system', userPrompt: 'user', knownFacts: [],
        fetchFinancialContext: async () => ({ facts: [] }), signal: controller.signal, toolRuntime,
        acquireModelSlot: (signal) => new Promise<() => void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      })) { /* consume */ }
    })()
    setTimeout(() => controller.abort(), 10)
    await running
    assert.equal(providerCalls, 0)
    assert.deepEqual((await projections.replay(executionId)).modelRequests, [])
  } finally {
    await analyses.removeResearch(analysisId)
    await pool.end()
  }
})

test('真实 OpenAI HTTP provider 经生产 Pi bridge 在 Turn 边界原子封存并按原调用序回送', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const providerRequests: Array<Record<string, unknown>> = []
  const provider = createServer(async (request, response) => {
    const body = await readJsonBody(request)
    providerRequests.push(body)
    const tools = (body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
    const visibleNames = tools.map((item) => item.function?.name).filter(Boolean)
    const messages = (body.messages as Array<{ role?: string }> | undefined) ?? []
    const toolResults = messages.filter(({ role }) => role === 'tool')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (visibleNames.includes('analyze_financials')) {
      if (toolResults.length === 0) {
        writeOpenAiToolCalls(response, [{ id: 'provider-specialist', name: 'analyze_financials', arguments: '{}' }])
      } else {
        writeOpenAiToolCalls(response, [{
          id: 'provider-report', name: 'submit_analysis_report', arguments: JSON.stringify(integratedReport({
            title: '真实生产 Pi bridge', marketState: '数据不足', trend: '未知', drivers: [],
            supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
            invalidationConditions: [], valuation: null, personalImpact: null,
            conditionalSuggestion: null, limitations: ['真实 HTTP provider 验收'],
          })),
        }])
      }
    } else if (toolResults.length === 0) {
      writeOpenAiToolCalls(response, [
        { id: 'provider-news', name: 'search_news_by_keyword', arguments: '{}' },
        { id: 'provider-indicators', name: 'get_technical_indicators', arguments: '{}' },
        { id: 'provider-hidden-guess', name: 'hidden_specialist_tool', arguments: '{}' },
      ])
    } else {
      writeOpenAiText(response, '专项已基于工具结果收口。')
    }
  })
  await listenHttp(provider)
  const providerAddress = provider.address()
  assert.ok(providerAddress && typeof providerAddress === 'object')

  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const settings = createRuntimeSettingsRepository(pool)
  const previousSettings = await settings.current()
  await settings.save({
    mainAgentToolRounds: 3, specialistAgentToolRounds: 2, toolConcurrency: 2,
  }, new Date().toISOString())
  const model = createPiModel({
    provider: 'local-openai', apiProtocol: 'chat-completions', modelName: 'integration-model',
    baseUrl: `http://127.0.0.1:${providerAddress.port}`, apiKey: 'integration-key',
  })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: events,
    runtimeSettingsRepository: settings,
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [], financials: {} }),
    searchNews: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { facts: [], source: 'news' }
    },
    fetchTechnicalIndicators: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { facts: [], source: 'indicators' }
    },
    model,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const symbol = `R${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  try {
    const sseResponse = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`)
    const sse = await readThrough(sseResponse, 'event: partial')
    await waitForAgentStatus(events, created.sessionId, 'partial')

    assert.equal(providerRequests.length, 4)
    const specialistFirst = providerRequests[1]!
    const specialistSecond = providerRequests[2]!
    const firstToolNames = providerToolNames(specialistFirst)
    assert.deepEqual(firstToolNames, ['search_news_by_keyword', 'get_technical_indicators'])
    const returnedIds = providerToolResultIds(specialistSecond)
    assert.deepEqual(returnedIds, [
      'provider-news:specialist-invocation:financial-specialist-1:attempt:1:position:1',
      'provider-indicators:specialist-invocation:financial-specialist-1:attempt:1:position:2',
      'provider-hidden-guess:specialist-invocation:financial-specialist-1:attempt:1:position:3',
    ])

    const runtime = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/tool-runtime`)
      .then((response) => response.json())
    assert.deepEqual(runtime.modelRequests.map((item: { projectionVersion: number }) => (
      item.projectionVersion
    )), [1, 2, 2, 1])
    assert.ok(runtime.modelRequests.every((item: { projectionVersion?: number }) => (
      Number.isInteger(item.projectionVersion) && item.projectionVersion! > 0
    )))
    const specialistBatch = runtime.toolBatches.find((batch: { calls: Array<{ toolName: string }> }) => (
      batch.calls.some(({ toolName }) => toolName === 'search_news_by_keyword')
    ))
    assert.equal(specialistBatch.status, 'failed')
    assert.deepEqual(specialistBatch.calls.map((call: { position: number }) => call.position), [1, 2, 3])
    const resultFor = (toolName: string) => specialistBatch.results.find(
      (result: { toolCallId: string }) => specialistBatch.calls.some(
        (call: { toolCallId: string; toolName: string }) => (
          call.toolCallId === result.toolCallId && call.toolName === toolName
        ),
      ),
    )
    const news = resultFor('search_news_by_keyword')
    const indicators = resultFor('get_technical_indicators')
    assert.ok(news.startedAt && news.completedAt && indicators.startedAt && indicators.completedAt)
    assert.ok(new Date(news.startedAt).getTime() <= new Date(indicators.startedAt).getTime())
    assert.ok(new Date(indicators.startedAt).getTime() < new Date(news.completedAt).getTime())
    assert.ok(indicators.completionOrder < news.completionOrder)
    assert.match(sse, /event: tool_result/)
    const ledger = await events.list(created.sessionId, 0)
    const callEvents = ledger.filter(({ payload }) => payload.type === 'tool_call'
      && ['search_news_by_keyword', 'get_technical_indicators'].includes(String(payload.name)))
    assert.deepEqual(callEvents.map(({ payload }) => ({
      name: payload.name, startedAt: typeof payload.startedAt,
    })).sort((left, right) => String(left.name).localeCompare(String(right.name))), [
      { name: 'get_technical_indicators', startedAt: 'string' },
      { name: 'search_news_by_keyword', startedAt: 'string' },
    ])
    const resultEvents = ledger.filter(({ payload }) => payload.type === 'tool_result'
      && ['search_news_by_keyword', 'get_technical_indicators'].includes(String(payload.name)))
    assert.deepEqual(resultEvents.map(({ payload }) => ({
      name: payload.name, startedAt: typeof payload.startedAt,
      completedAt: typeof payload.completedAt, completionOrder: payload.completionOrder,
    })), [
      { name: 'get_technical_indicators', startedAt: 'string', completedAt: 'string', completionOrder: 2 },
      { name: 'search_news_by_keyword', startedAt: 'string', completedAt: 'string', completionOrder: 3 },
    ])
    const resultPayloads = ledger.filter(
      ({ payload }) => payload.type === 'tool_result',
    ).map(({ payload }) => payload.name)
    assert.ok(resultPayloads.indexOf('get_technical_indicators')
      < resultPayloads.indexOf('search_news_by_keyword'))
    const research = await fetch(`${baseUrl}/api/research/${created.analysisId}`)
      .then((response) => response.json()) as { trace: Array<Record<string, unknown>> }
    const webToolEvents = research.trace.filter((payload) => (
      ['tool_call', 'tool_result'].includes(String(payload.type))
      && ['search_news_by_keyword', 'get_technical_indicators'].includes(String(payload.name))
    ))
    assert.ok(webToolEvents.every((payload) => typeof payload.startedAt === 'string'))
    assert.ok(webToolEvents.filter(({ type }) => type === 'tool_result').every((payload) => (
      typeof payload.completedAt === 'string' && Number.isInteger(payload.completionOrder)
    )))
    const publicAudit = JSON.stringify({ runtime, sse })
    assert.doesNotMatch(publicAudit, /hidden_specialist_tool/)
    assert.doesNotMatch(publicAudit, /allowedStages|allowedRoles|visibilityConditions/)

    const serialSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolConcurrency: 1 }),
    })
    assert.equal(serialSettings.status, 200)
    const serialCreated = await fetch(`${baseUrl}/api/analyses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: `S${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}` }),
    }).then((response) => response.json()) as { analysisId: string; sessionId: string }
    await waitForAgentStatus(events, serialCreated.sessionId, 'partial')
    const serialRuntime = await fetch(
      `${baseUrl}/api/agent-sessions/${serialCreated.sessionId}/tool-runtime`,
    ).then((response) => response.json())
    const serialBatch = serialRuntime.toolBatches.find(
      (batch: { calls: Array<{ toolName: string }> }) => batch.calls.some(
        ({ toolName }) => toolName === 'search_news_by_keyword',
      ),
    )
    const serialResultFor = (toolName: string) => serialBatch.results.find(
      (result: { toolCallId: string }) => serialBatch.calls.some(
        (call: { toolCallId: string; toolName: string }) => (
          call.toolCallId === result.toolCallId && call.toolName === toolName
        ),
      ),
    )
    const serialNews = serialResultFor('search_news_by_keyword')
    const serialIndicators = serialResultFor('get_technical_indicators')
    assert.notEqual(serialNews.startedAt, serialIndicators.startedAt)
    assert.ok(new Date(serialNews.completedAt).getTime()
      <= new Date(serialIndicators.startedAt).getTime())
    const serialLedger = await events.list(serialCreated.sessionId, 0)
    assert.deepEqual(serialLedger.filter(({ payload }) => payload.type === 'tool_call'
      && ['search_news_by_keyword', 'get_technical_indicators'].includes(String(payload.name)))
      .map(({ payload }) => payload.startedAt), [serialNews.startedAt, serialIndicators.startedAt])
  } finally {
    await settings.save(previousSettings.values, new Date().toISOString())
    await app.close()
    await closeHttp(provider)
  }
})

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
  const toolRuntime = createToolProjectionRepository(pool)
  let modelStarted!: () => void
  const started = new Promise<void>((resolve) => { modelStarted = resolve })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: toolRuntime,
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
    const createdAt = new Date().toISOString()
    const projection = await toolRuntime.ensureVersion({
      executionId: originalExecutionId, role: 'main', stage: 'research',
      schemaHash: 'old-generation-visible-only',
      projectedTools: [{
        name: 'fetch_financial_context', description: 'visible',
        parameters: { type: 'object' },
      }],
      visibleToolNames: ['fetch_financial_context'], reasons: { stage: 'research' }, createdAt,
    })
    await toolRuntime.recordModelRequest({
      id: `execution:${originalExecutionId}:main:model-attempt:1`,
      executionId: originalExecutionId, projectionId: projection.id, turnIndex: 1, createdAt,
    })
    await toolRuntime.beginToolBatch({
      id: `execution:${originalExecutionId}:batch:1`, executionId: originalExecutionId,
      projectionId: projection.id, turnIndex: 1, createdAt,
      calls: [{ toolCallId: 'old-call', toolName: 'fetch_financial_context', position: 1 }],
    })
    await toolRuntime.startToolCall({
      batchId: `execution:${originalExecutionId}:batch:1`, executionId: originalExecutionId,
      toolCallId: 'old-call', startedAt: createdAt,
      operationId: `execution:${originalExecutionId}:tool:old-call:call`,
      eventPayload: {
        type: 'tool_call', name: 'fetch_financial_context', toolCallId: 'old-call',
        input: {}, startedAt: createdAt,
      },
    })
    await toolRuntime.completeToolBatch({
      id: `execution:${originalExecutionId}:batch:1`, executionId: originalExecutionId,
      completedAt: createdAt,
      results: [{
        toolCallId: 'old-call', status: 'completed', startedAt: createdAt,
        completedAt: createdAt, completionOrder: 1,
        resultPayload: { toolName: 'fetch_financial_context', result: { facts: [] }, isError: false },
        operationId: `execution:${originalExecutionId}:tool:old-call:result`,
        eventPayload: {
          type: 'tool_result', name: 'fetch_financial_context', toolCallId: 'old-call',
          result: { facts: [] }, isError: false,
        },
      }],
    })
    const waitingBatchId = `execution:${originalExecutionId}:batch:waiting`
    const waitingCallId = 'waiting-before-start'
    await toolRuntime.beginToolBatch({
      id: waitingBatchId, executionId: originalExecutionId,
      projectionId: projection.id, turnIndex: 2, createdAt,
      calls: [{ toolCallId: waitingCallId, toolName: 'fetch_financial_context', position: 1 }],
    })
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
    assertSubsequence(eventTypes(replay), ['tool_call', 'tool_result', 'stopping', 'stopped'])
    assert.match(replay, /"toolCallId":"waiting-before-start"/)
    assert.match(replay, /"startedAt":null/)
    assert.match(replay, /"notStarted":true/)

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

    const oldRuntimeResponse = await fetch(
      `${baseUrl}/api/agent-sessions/${created.sessionId}/tool-runtime?executionId=${originalExecutionId}`,
    )
    assert.equal(oldRuntimeResponse.status, 200)
    const oldRuntime = await oldRuntimeResponse.json()
    assert.equal(oldRuntime.executionId, originalExecutionId)
    assert.deepEqual(oldRuntime.projections.map((item: { visibleToolNames: string[] }) => (
      item.visibleToolNames
    )), [['fetch_financial_context']])
    assert.equal(oldRuntime.modelRequests.length, 1)
    assert.equal(oldRuntime.toolBatches[0]?.results[0]?.resultPayload?.toolName, 'fetch_financial_context')
    const waitingBatch = oldRuntime.toolBatches.find(({ id }: { id: string }) => id === waitingBatchId)
    assert.equal(waitingBatch?.status, 'cancelled')
    assert.deepEqual(waitingBatch?.results[0], {
      toolCallId: waitingCallId, status: 'cancelled', startedAt: null,
      completedAt: waitingBatch.results[0].completedAt, completionOrder: 1,
      resultPayload: {
        toolCallId: waitingCallId, toolName: 'fetch_financial_context',
        result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      },
    })
    const publicCancellation = JSON.stringify({ research, replay, oldRuntime })
    assert.doesNotMatch(publicCancellation, /hidden_tool|secret-raw-argument|allowedStages|开放条件/)
    const cancellationTrace = research.trace.filter(
      (entry: { toolCallId?: string }) => entry.toolCallId === waitingCallId,
    )
    assert.deepEqual(cancellationTrace.map((entry: { type: string }) => entry.type),
      ['tool_call', 'tool_result'])
    assert.equal(cancellationTrace[0]?.startedAt, null)
    assert.equal(cancellationTrace[0]?.notStarted, true)
    assert.doesNotMatch(JSON.stringify(oldRuntime), /hidden_tool|allowedStages|开放条件/)

    const foreign = await events.createResearch({
      analysisId: `foreign-${created.analysisId}`, sessionId: `foreign-${created.sessionId}`,
      executionId: `foreign-${originalExecutionId}`, symbol: 'FOREIGN', status: 'running',
      operationId: `foreign-${originalExecutionId}:running`,
      event: { type: 'status', status: 'running' }, createdAt: new Date().toISOString(),
    })
    assert.ok(foreign)
    const crossSession = await fetch(
      `${baseUrl}/api/agent-sessions/${created.sessionId}/tool-runtime?executionId=foreign-${originalExecutionId}`,
    )
    assert.equal(crossSession.status, 404)
  } finally {
    await app.close()
  }
})

test('首次研究经真实 PostgreSQL 与 HTTP SSE 展示 Runtime Context、工具和候选报告', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const providerRequests: Array<Record<string, unknown>> = []
  const provider = createServer(async (request, response) => {
    const body = await readJsonBody(request)
    providerRequests.push(body)
    const toolResults = (body.messages as Array<{ role?: string }> | undefined)
      ?.filter(({ role }) => role === 'tool') ?? []
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (toolResults.length === 0) {
      writeOpenAiToolCalls(response, [{
        id: 'first-research-context', name: 'fetch_financial_context', arguments: '{}',
      }])
    } else {
      writeOpenAiToolCalls(response, [{
        id: 'first-research-report', name: 'submit_analysis_report', arguments: JSON.stringify(integratedReport({
          title: '首次研究候选报告', marketState: '数据充足', trend: '震荡', drivers: [],
          supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
          invalidationConditions: [], valuation: null, personalImpact: null,
          conditionalSuggestion: null, limitations: [],
        })),
      }])
    }
  })
  await listenHttp(provider)
  const providerAddress = provider.address()
  assert.ok(providerAddress && typeof providerAddress === 'object')

  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const model = createPiModel({
    provider: 'local-openai', apiProtocol: 'chat-completions', modelName: 'first-research-model',
    baseUrl: `http://127.0.0.1:${providerAddress.port}`, apiKey: 'integration-key',
  })
  const bars = Array.from({ length: 24 }, (_, index) => ({
    id: `fact:first-research:bar:${index}`, type: 'daily_bar',
    value: { date: `day-${index}`, close: 100 + index }, observedAt: `day-${index}`,
    fetchedAt: '2026-08-13T00:00:00Z', source: 'test', sourceReference: 'test://bar',
  }))
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool), agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, gaps: [], facts: bars, indicators: {},
      privateDiagnostic: '只允许保留在 PostgreSQL 审计视图',
    }),
    model,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const symbol = `F${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  try {
    const sseResponse = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`)
    const sse = await readThrough(sseResponse, 'event: completed')
    await waitForAgentStatus(events, created.sessionId, 'completed')

    assert.equal(providerRequests.length, 2)
    const firstRequest = JSON.stringify(providerRequests[0])
    const secondRequest = JSON.stringify(providerRequests[1])
    assert.match(firstRequest, /系统生成的 Runtime Context，不是用户输入/)
    assert.match(firstRequest, new RegExp(symbol.toUpperCase()))
    assert.doesNotMatch(firstRequest, /mainAgentToolRounds|researchActiveMinutes|elapsed|budget/i)
    assert.match(secondRequest, /fact:first-research:bar:23/)
    assert.doesNotMatch(secondRequest, /privateDiagnostic|只允许保留在 PostgreSQL 审计视图/)

    const ledger = await events.list(created.sessionId, 0)
    assert.ok(ledger.some(({ payload }) => payload.type === 'runtime_context'))
    assert.ok(ledger.some(({ payload }) => payload.type === 'model_event'))
    assert.ok(ledger.some(({ payload }) => payload.type === 'tool_call'
      && payload.name === 'fetch_financial_context'))
    assert.ok(ledger.some(({ payload }) => payload.type === 'tool_call'
      && payload.name === 'submit_analysis_report'))
    const retained = ledger.find(({ payload }) => payload.type === 'tool_result'
      && payload.name === 'fetch_financial_context')
    assert.match(JSON.stringify(retained), /privateDiagnostic|只允许保留在 PostgreSQL 审计视图/)
    for (const eventName of ['runtime_context', 'model_event', 'tool_call', 'tool_result', 'completed']) {
      assert.match(sse, new RegExp(`event: ${eventName}`))
    }
    const research = await fetch(`${baseUrl}/api/research/${created.analysisId}`)
      .then((response) => response.json())
    assert.equal(research.report.title, '首次研究候选报告')
    const versions = await fetch(`${baseUrl}/api/research/${created.analysisId}/report-versions`)
      .then((response) => response.json())
    assert.equal(versions.items.length, 1)
    assert.equal(versions.items[0].version, 1)
    assert.equal(versions.items[0].kind, 'integrated')
    assert.equal(versions.items[0].report.title, '首次研究候选报告')
    assert.match(versions.items[0].payloadHash, /^[a-f0-9]{64}$/)
  } finally {
    await app.close()
    await closeHttp(provider)
  }
})

test('主 Agent 经真实 PostgreSQL、HTTP 与 SSE 启动并展示独立消息面 Agent', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const candidate = {
    id: 'fact:news:e2e:candidate', type: 'news',
    value: {
      title: 'NVDA product event', summary: 'title lead',
      url: 'https://example.com/event', evidenceLevel: 'title_only',
    },
    evidenceLevel: 'title_only', observedAt: '2026-08-12T12:00:00Z',
    fetchedAt: '2026-08-13T12:00:00Z', source: 'google-news',
    sourceReference: 'https://example.com/event',
  }
  const verified = {
    ...candidate, id: 'fact:news:e2e:document', type: 'news_document',
    evidenceLevel: 'verified_news', value: {
      ...candidate.value, summary: 'bounded verified summary',
      contentHash: 'a'.repeat(64), evidenceLevel: 'verified_news',
      metadata: { contentType: 'text/html', excerptBytes: 24, truncated: false },
    },
  }
  const specialistReport = {
    kind: 'specialist' as const, domain: 'news', availability: 'available' as const,
    status: 'completed' as const, gaps: [], limitations: [], keyJudgments: [{
      type: 'news', statement: '产品事件对近期预期偏正面', direction: 'bullish', confidence: 'medium',
      supportingEvidence: [verified.id], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['公司取消活动'],
    }],
  }
  const mainReport = integratedReport({
    title: '消息面专项闭环', marketState: '数据有限', trend: '震荡', drivers: [],
    supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
    invalidationConditions: [], valuation: null, personalImpact: null,
    conditionalSuggestion: null, limitations: [],
  })
  const mainModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('run_news_analysis', {
      launch: true, researchQuestion: '近 30 天是否有改变预期的事件？',
      reason: '缺少消息面反方证据。',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', mainReport), { stopReason: 'toolUse' }),
  ] })
  const newsModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('search_news_candidates', {
      query: 'NVDA product event',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read_news_document', {
      factId: candidate.id,
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_specialist_report', specialistReport), {
      stopReason: 'toolUse',
    }),
  ] })
  const model = { ...mainModel, analyzeNews: newsModel.analyzeNews }
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool), agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    searchNewsCandidates: async () => ({ facts: [candidate] }),
    readNewsDocument: async (input) => {
      assert.equal(input.id, candidate.id)
      return { facts: [verified], excerpt: 'bounded verified excerpt' }
    },
    listCompanyEvents: async () => ({ facts: [] }), model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: `N${crypto.randomUUID().slice(0, 8)}` },
  })).json() as { analysisId: string; sessionId: string }
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'completed')
    const research = (await app.inject({
      method: 'GET', url: `/api/research/${created.analysisId}`,
    })).json()
    assert.equal(research.specialistAgents.length, 1)
    const news = research.specialistAgents[0]
    assert.equal(news.domain, 'news')
    assert.equal(news.execution.status, 'completed')
    assert.match(JSON.stringify(news.events), /search_news_candidates/)
    assert.match(JSON.stringify(news.events), /read_news_document/)
    assert.match(JSON.stringify(news.events), /fact:news:e2e:candidate/)
    assert.match(JSON.stringify(news.events), /fact:news:e2e:document/)
    assert.doesNotMatch(JSON.stringify(news.events), /bounded verified excerpt/)
    assert.match(JSON.stringify(news.events), /bounded verified summary/)
    assert.equal(news.researchQuestion, '近 30 天是否有改变预期的事件？')
    assert.equal(news.reason, '缺少消息面反方证据。')

    const mainLedger = await events.list(created.sessionId, 0)
    const specialistResult = mainLedger.find(({ payload }) => (
      payload.type === 'tool_result' && payload.name === 'run_news_analysis'
    ))?.payload.result
    assert.match(JSON.stringify(specialistResult), /产品事件对近期预期偏正面/)
    assert.match(JSON.stringify(specialistResult), new RegExp(verified.id))

    const sse = await app.inject({
      method: 'GET', url: `/api/agent-sessions/${news.id}/events`,
    })
    assert.match(sse.body, /event: tool_call/)
    assert.match(sse.body, /event: tool_result/)
    assert.match(sse.body, /event: completed/)
    const versions = (await app.inject({
      method: 'GET', url: `/api/research/${created.analysisId}/report-versions`,
    })).json().items
    assert.deepEqual(versions.map((version: any) => ({
      kind: version.kind, sessionId: version.sessionId,
      domain: version.report.domain ?? null, evidence: version.report.keyJudgments?.[0]?.supportingEvidence ?? [],
    })), [
      { kind: 'specialist', sessionId: news.id, domain: 'news', evidence: [verified.id] },
      { kind: 'integrated', sessionId: created.sessionId, domain: null, evidence: [] },
    ])
  } finally {
    await app.close()
  }
})

test('Web Search 只在三源资格事件后投影并经正文核实生成专项版本', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const lead = {
    id: 'fact:web:e2e:lead', type: 'web_search_lead', evidenceLevel: 'lead',
    value: { title: 'NVDA event detail', summary: 'search snippet', url: 'https://example.com/web-event' },
    observedAt: '2026-08-13T12:00:00Z', fetchedAt: '2026-08-13T12:01:00Z',
    source: 'bing-web-search', sourceReference: 'https://example.com/web-event',
  }
  const verified = {
    ...lead, id: 'fact:web:e2e:verified', type: 'news_document', evidenceLevel: 'verified_news',
    value: { candidateFactId: lead.id, summary: 'verified event detail', contentHash: 'b'.repeat(64),
      url: lead.sourceReference, metadata: { contentType: 'text/html', excerptBytes: 21, truncated: false } },
  }
  const specialistReport = {
    kind: 'specialist' as const, domain: 'news', availability: 'available' as const,
    status: 'completed' as const, gaps: [], limitations: [], keyJudgments: [{
      type: 'news', statement: '补充搜索核实了产品事件', direction: 'bullish', confidence: 'medium',
      supportingEvidence: [verified.id], contraryEvidence: [], contraryEvidenceStatus: 'none_found',
      invalidationConditions: ['事件取消'],
    }],
  }
  const mainModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('run_news_analysis', {
      launch: true, researchQuestion: '核实近期产品事件', reason: '常规新闻材料不足',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', integratedReport({
      title: 'Web Search 降级闭环', marketState: '材料有限', trend: '震荡', drivers: [],
      supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
      invalidationConditions: [], valuation: null, personalImpact: null,
      conditionalSuggestion: null, limitations: [],
    })), { stopReason: 'toolUse' }),
  ] })
  const newsModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('search_web_evidence', { query: 'NVDA event' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_candidates', { query: 'NVDA event' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_web_evidence', { query: 'NVDA event' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read_news_document', { factId: lead.id }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_specialist_report', specialistReport), { stopReason: 'toolUse' }),
  ] })
  const model = { ...mainModel, analyzeNews: newsModel.analyzeNews }
  let webSearchCalls = 0
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool), analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: events, runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    searchNewsCandidates: async () => ({ facts: [], eligibility: {
      eligible: true, normalizedQuery: 'NVDA event', reasons: [
        { source: 'yahoo', reason: 'empty' }, { source: 'google-news', reason: 'title_only' },
        { source: 'alpaca', reason: 'unavailable' },
      ],
    } }),
    searchWebEvidence: async () => { webSearchCalls += 1; return { facts: [lead] } },
    readNewsDocument: async (candidate) => { assert.equal(candidate.id, lead.id); return { facts: [verified] } },
    listCompanyEvents: async () => ({ facts: [] }), model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: `W${crypto.randomUUID().slice(0, 8)}` },
  })).json() as { analysisId: string; sessionId: string }
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'completed')
    const research = (await app.inject({ method: 'GET', url: `/api/research/${created.analysisId}` })).json()
    const news = research.specialistAgents[0]
    const serialized = JSON.stringify(news.events)
    assert.equal(webSearchCalls, 1)
    assert.match(serialized, /web_search_eligibility/)
    assert.match(serialized, /search_web_evidence/)
    assert.match(serialized, /tool_not_available/)
    assert.match(serialized, /fact:web:e2e:lead/)
    assert.match(serialized, /fact:web:e2e:verified/)
    const eligibilitySequence = news.events.find((event: any) => event.type === 'web_search_eligibility').sequence
    const candidateResultSequence = news.events.find((event: any) => (
      event.type === 'tool_result' && event.name === 'search_news_candidates'
    )).sequence
    assert.ok(eligibilitySequence > candidateResultSequence)
    const replay = await app.inject({ method: 'GET', url: `/api/agent-sessions/${news.id}/events` })
    assert.match(replay.body, /event: web_search_eligibility/)
    const versions = (await app.inject({
      method: 'GET', url: `/api/research/${created.analysisId}/report-versions`,
    })).json().items
    assert.equal(versions[0].report.keyJudgments[0].supportingEvidence[0], verified.id)
  } finally { await app.close() }
})

test('主 Agent 经真实 PostgreSQL、HTTP 与 SSE 启动并展示独立基本面 Agent', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const reported = {
    id: `fact:fundamental:e2e:reported:${crypto.randomUUID()}`, type: 'reported_financial',
    value: { metric: 'revenue', period: '2026-Q2', value: 46_743_000_000 },
    evidenceLevel: 'reported_financial', observedAt: '2026-07-31',
    fetchedAt: '2026-08-13T12:00:00Z', source: 'sec',
    sourceReference: 'https://www.sec.gov/Archives/edgar/data/1045810/q2.htm',
  }
  const filing = {
    ...reported, id: `fact:fundamental:e2e:filing:bytes:0-65535:${'a'.repeat(16)}`,
    type: 'filing_document', evidenceLevel: 'official_filing',
    value: {
      filingId: '0001045810-26-000123', form: '10-Q', filedAt: '2026-07-31',
      startByte: 0, endByte: 65535, summary: 'Revenue increased.', contentHash: 'a'.repeat(64),
    },
  }
  const officialEvent = {
    ...reported, id: `fact:fundamental:e2e:event:${crypto.randomUUID()}`,
    type: 'company_event', evidenceLevel: 'official_company_event',
    value: { filingId: '0001045810-26-000123', form: '10-Q', eventType: 'earnings' },
  }
  const specialistReport = {
    kind: 'specialist' as const, domain: 'fundamental_valuation',
    availability: 'available' as const, status: 'completed' as const, gaps: [], limitations: [],
    keyJudgments: [{
      type: 'fundamental', statement: '正式财报支持基本面质量偏强',
      direction: 'bullish', confidence: 'medium',
      supportingEvidence: [reported.id, filing.id], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['下期收入同比转负'],
    }],
  }
  const mainModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('run_fundamental_analysis', {
      launch: true, researchQuestion: '最新正式财务事实是否改变基本面方向？',
      reason: '需要核验财报、指标序列与官方事件。',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', integratedReport({
      title: '基本面专项闭环', marketState: '数据有限', trend: '震荡', drivers: [],
      supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
      invalidationConditions: [], valuation: null, personalImpact: null,
      conditionalSuggestion: null, limitations: [],
    })), { stopReason: 'toolUse' }),
  ] })
  const specialistModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage([
      fauxToolCall('get_financial_overview', { symbol: 'NVDA' }, { id: 'fundamental-overview' }),
      fauxToolCall('get_financial_metric_series', {
        symbol: 'NVDA', metric: 'revenue_yoy',
      }, { id: 'fundamental-series' }),
      fauxToolCall('read_filing_document', {
        symbol: 'NVDA', filingId: '0001045810-26-000123',
      }, { id: 'fundamental-filing' }),
      fauxToolCall('list_company_events', { symbol: 'NVDA' }, { id: 'fundamental-events' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_specialist_report', specialistReport), {
      stopReason: 'toolUse',
    }),
  ] })
  const model = { ...mainModel, analyzeFundamental: specialistModel.analyzeFundamental }
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool), agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    getFinancialOverview: async () => ({
      overview: { symbol: 'NVDA', latestPeriod: '2026-Q2', qualityFlags: [] },
      facts: [reported], sources: [],
    }),
    getFinancialMetricSeries: async () => ({
      facts: [], returnedCount: 0, totalCount: 23, nextCursor: '20', truncated: true,
    }),
    readFilingDocument: async () => ({
      facts: [filing], items: [{
        startByte: 0, endByte: 65535, summary: 'Revenue increased.', contentHash: 'a'.repeat(64),
      }],
      returnedCount: 65536, totalCount: 200000, nextCursor: '65536', truncated: true,
    }),
    listOfficialCompanyEvents: async () => ({ facts: [officialEvent], sources: [] }), model,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'NVDA' }),
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'completed')
    const research = await fetch(`${baseUrl}/api/research/${created.analysisId}`)
      .then((response) => response.json())
    const fundamental = research.specialistAgents.find(
      (agent: { domain: string }) => agent.domain === 'fundamental_valuation',
    )
    assert.equal(fundamental.execution.status, 'completed')
    const serialized = JSON.stringify(fundamental.events)
    for (const tool of [
      'get_financial_overview', 'get_financial_metric_series',
      'read_filing_document', 'list_company_events', 'submit_specialist_report',
    ]) assert.match(serialized, new RegExp(tool))
    assert.match(serialized, new RegExp(reported.id))
    assert.match(serialized, new RegExp(filing.id))
    assert.match(serialized, /"totalCount":23/)
    assert.match(serialized, /"nextCursor":"20"/)
    assert.equal(fundamental.researchQuestion, '最新正式财务事实是否改变基本面方向？')
    assert.equal(fundamental.reason, '需要核验财报、指标序列与官方事件。')

    const replay = await fetch(`${baseUrl}/api/agent-sessions/${fundamental.id}/events`)
      .then((response) => response.text())
    assert.match(replay, /event: tool_call/)
    assert.match(replay, /event: tool_result/)
    assert.match(replay, /event: completed/)
    const versions = await fetch(`${baseUrl}/api/research/${created.analysisId}/report-versions`)
      .then((response) => response.json())
    const specialistVersion = versions.items.find(
      (version: { kind: string }) => version.kind === 'specialist',
    )
    assert.equal(specialistVersion.sessionId, fundamental.id)
    assert.equal(specialistVersion.version, 1)
    assert.equal(specialistVersion.report.domain, 'fundamental_valuation')
    assert.deepEqual(specialistVersion.report.keyJudgments[0].supportingEvidence, [reported.id, filing.id])
    assert.match(specialistVersion.payloadHash, /^[a-f0-9]{64}$/)
  } finally { await app.close() }
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
      fauxToolCall('submit_analysis_report', integratedReport(report), { id: 'budget-report' }),
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
      'fetch_financial_context', 'analyze_financials', 'run_news_analysis', 'submit_analysis_report',
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
      fauxToolCall('submit_analysis_report', integratedReport(report), { id: reportCallId }),
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
    ])
    assert.deepEqual(sealedBatch.slice(0, 4).map(({ payload }) => payload.type), [
      'tool_call', 'tool_call', 'tool_result', 'tool_result',
    ])
    assert.equal(sealedBatch[2]?.payload.isError, false)
    assert.equal(sealedBatch[3]?.payload.isError, true)
    assert.deepEqual(sealedBatch[3]?.payload && {
      ...sealedBatch[3].payload,
      startedAt: typeof sealedBatch[3].payload.startedAt,
      completedAt: typeof sealedBatch[3].payload.completedAt,
    }, {
      type: 'tool_result', name: 'fetch_financial_context',
      toolCallId: `${cancelledAfterReportCallId}:main-attempt:2:position:2`,
      result: { error: 'cancelled_after_report_submission', facts: [] },
      isError: true, startedAt: 'string', completedAt: 'string', completionOrder: 2,
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
      fauxToolCall('hidden_main_tool', { secret: 'must-not-leak' }, { id: unknownCallId }),
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
      assert.deepEqual(sealed.slice(3, 5).map(({ payload }) => ({
        ...payload, startedAt: typeof payload.startedAt, completedAt: typeof payload.completedAt,
      })), [
        {
          type: 'tool_result', name: 'tool_not_available',
          toolCallId: runtimeIds[0],
          result: { error: 'tool_not_available', facts: [] }, isError: true,
          startedAt: 'string', completedAt: 'string', completionOrder: 1,
          operationId: `${prefix}:${runtimeIds[0]}:result`,
        },
        {
          type: 'tool_result', name: 'fetch_financial_context',
          toolCallId: runtimeIds[1],
          result: { error: 'invalid_tool_arguments', facts: [] }, isError: true,
          startedAt: 'string', completedAt: 'string', completionOrder: 2,
          operationId: `${prefix}:${runtimeIds[1]}:result`,
        },
      ])
      assert.deepEqual(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? message.toolCallId : ''), [
        ...runtimeIds,
      ])
      providerObservedSealedLedger = true
      assert.doesNotMatch(JSON.stringify(sealed), /hidden_main_tool|must-not-leak/)
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', integratedReport(report), { id: reportCallId }),
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
    const session = await events.getSession(created.sessionId)
    assert.ok(session)
    const [researchResponse, runtimeResponse, sseResponse] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/research/${created.analysisId}` }),
      app.inject({
        method: 'GET',
        url: `/api/agent-sessions/${created.sessionId}/tool-runtime?executionId=${session.executionId}`,
      }),
      app.inject({ method: 'GET', url: `/api/agent-sessions/${created.sessionId}/events` }),
    ])
    const publicReadback = JSON.stringify({
      research: researchResponse.json(), runtime: runtimeResponse.json(), sse: sseResponse.body,
    })
    assert.doesNotMatch(publicReadback, /hidden_main_tool|must-not-leak/)
    const publicUnknown = researchResponse.json().trace.find((payload: Record<string, unknown>) => (
      payload.type === 'tool_result' && payload.name === 'tool_not_available'
    ))
    assert.equal(publicUnknown.toolCallId,
      `${unknownCallId}:main-attempt:1:position:1`)
    assert.doesNotMatch(sseResponse.body, /hidden_main_tool|must-not-leak/)
  } finally {
    await app.close()
  }
})

test('主 Agent 三次拒绝候选保留 hash 事件且不生成报告版本', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const events = createAgentEventRepository(pool)
  const badReport = integratedReport({
    title: '无法追溯的候选', marketState: '未知', trend: '未知', drivers: [],
    supportingEvidence: [], contraryEvidence: [], scenarios: [], invalidationConditions: [],
    valuation: null, personalImpact: null, conditionalSuggestion: null, limitations: [],
    keyJudgments: [{
      type: 'market', statement: '无法追溯的结论', direction: 'neutral', confidence: 'low',
      supportingEvidence: ['fact:not-in-research'], contraryEvidence: [],
      contraryEvidenceStatus: 'not_searched', invalidationConditions: [],
    }],
  })
  const model = createPiModel({ fauxResponses: Array.from({ length: 3 }, (_, index) => (
    fauxAssistantMessage(
      fauxToolCall('submit_analysis_report', badReport, { id: `rejected-report-${index + 1}` }),
      { stopReason: 'toolUse' },
    )
  )) })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool), agentEventRepository: events,
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }), model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: `RJ${crypto.randomUUID().slice(0, 8)}` },
  })).json() as { analysisId: string; sessionId: string }
  try {
    await waitForAnalysisStatus(app, created.analysisId, 'failed')
    const ledger = await events.list(created.sessionId, 0)
    const rejections = ledger.filter(({ payload }) => payload.type === 'tool_result'
      && payload.name === 'submit_analysis_report' && payload.isError === true)
    assert.equal(rejections.length, 3)
    const hashes = rejections.map(({ payload }) => String(
      (payload.result as Record<string, unknown>).candidatePayloadHash,
    ))
    assert.ok(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    assert.equal(new Set(hashes).size, 1)
    assert.match(JSON.stringify(rejections), /reference_integrity/)
    const replay = await app.inject({
      method: 'GET', url: `/api/agent-sessions/${created.sessionId}/events`,
    })
    assert.match(replay.body, new RegExp(hashes[0]!))
    const versions = await app.inject({
      method: 'GET', url: `/api/research/${created.analysisId}/report-versions`,
    })
    assert.deepEqual(versions.json(), { items: [] })
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
      assert.ok((await events.list(createdSessionId, 0)).length >= beforeReplay)
      providerChecks += 1
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', integratedReport(report), { id: reportCallId }),
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
      return fauxAssistantMessage('第二次专项完成')
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', integratedReport(report)), { stopReason: 'toolUse' }),
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
    const executionId = (await events.getSession(created.sessionId))!.executionId
    await waitForOperation(events, created.sessionId,
      `execution:${executionId}:specialist:financial-specialist-2:completed`)
    const runtime = await createToolProjectionRepository(pool).replay(executionId)
    assert.equal(runtime.modelRequests.filter(({ id }) => id.includes(':fundamental:invocation:')).length, 4)
    assert.equal(runtime.toolBatches.filter(({ id }) => id.includes(':fundamental:invocation:')).length, 2)
    const lifecycle = (await events.list(created.sessionId, 0)).filter(({ operationId }) => (
      operationId.includes(':specialist:financial-specialist-')
      && (operationId.endsWith(':waiting') || operationId.endsWith(':completed'))
    ))
    assert.deepEqual(lifecycle.map(({ operationId }) => operationId), [
      `execution:${executionId}:specialist:financial-specialist-1:waiting`,
      `execution:${executionId}:specialist:financial-specialist-1:completed`,
      `execution:${executionId}:specialist:financial-specialist-2:waiting`,
      `execution:${executionId}:specialist:financial-specialist-2:completed`,
    ])
    const replayBody = (await app.inject({
      method: 'GET', url: `/api/agent-sessions/${created.sessionId}/events`,
    })).body
    assert.equal((replayBody.match(/event: waiting_for_specialists/g) ?? []).length, 2)
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

async function waitForOperation(
  repository: ReturnType<typeof createAgentEventRepository>, sessionId: string, operationId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await repository.list(sessionId, 0)).some((event) => event.operationId === operationId)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`agent_operation_not_persisted:${operationId}`)
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

function eventTypes(body: string) {
  return [...body.matchAll(/^event: ([^\n]+)$/gm)].map((match) => match[1])
}

async function readJsonBody(request: IncomingMessage) {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body) as Record<string, unknown>
}

function writeOpenAiToolCalls(
  response: import('node:http').ServerResponse,
  calls: Array<{ id: string; name: string; arguments: string }>,
) {
  writeOpenAiChunk(response, {
    role: 'assistant',
    tool_calls: calls.map((call, index) => ({
      index, id: call.id, type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  })
  writeOpenAiChunk(response, {}, 'tool_calls')
  response.end('data: [DONE]\n\n')
}

function writeOpenAiText(response: import('node:http').ServerResponse, text: string) {
  writeOpenAiChunk(response, { role: 'assistant', content: text })
  writeOpenAiChunk(response, {}, 'stop')
  response.end('data: [DONE]\n\n')
}

function writeOpenAiChunk(
  response: import('node:http').ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(`data: ${JSON.stringify({
    id: crypto.randomUUID(), object: 'chat.completion.chunk', created: 1,
    model: 'integration-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`)
}

function providerToolNames(request: Record<string, unknown>) {
  return ((request.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
    .map((item) => item.function?.name).filter((name): name is string => Boolean(name))
}

function providerToolResultIds(request: Record<string, unknown>) {
  return ((request.messages as Array<{ role?: string; tool_call_id?: string }> | undefined) ?? [])
    .filter(({ role }) => role === 'tool')
    .map(({ tool_call_id }) => tool_call_id).filter((id): id is string => Boolean(id))
}

async function listenHttp(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeHttp(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )))
}
