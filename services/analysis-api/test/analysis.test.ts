import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'

import { createPiModel, type ModelEvent } from '../src/model.js'
import { buildApp as buildProductionApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'

const testDatabases = new Map<string, ReturnType<typeof createTestProductDatabase>>()

function buildApp(dependencies: Parameters<typeof buildProductionApp>[0] & { storageKey?: string }) {
  const { storageKey = crypto.randomUUID(), ...appDependencies } = dependencies
  const database = testDatabases.get(storageKey) ?? createTestProductDatabase()
  testDatabases.set(storageKey, database)
  return buildProductionApp({ ...database, ...appDependencies })
}

const fact = {
  id: 'fact:NVDA:quote:sina:2026-08-12T13:48:38Z', type: 'quote', value: 217.5,
  observedAt: '2026-08-12T13:48:38Z', fetchedAt: '2026-08-12T14:00:00Z',
  source: 'sina', sourceReference: 'https://example.com/NVDA',
}

const report = {
  title: 'NVDA 一至四周综合分析', marketState: '偏强', trend: '偏强震荡', drivers: ['量价'],
  supportingEvidence: [fact.id], contraryEvidence: [fact.id],
  scenarios: [{ name: '延续', condition: '站稳', outcome: '上行' }],
  invalidationConditions: ['跌破均线'], valuation: null, personalImpact: null,
  conditionalSuggestion: null, limitations: [],
  keyJudgments: [{ judgment: '短期偏强', evidence: [fact.id] }],
}

const reportCandidate = {
  kind: 'integrated' as const, availability: 'available' as const,
  status: 'completed' as const, gaps: [], ...report,
  keyJudgments: report.keyJudgments.map(({ judgment, evidence }) => ({
    type: 'market' as const, statement: judgment, direction: 'bullish' as const,
    confidence: 'medium' as const, supportingEvidence: evidence,
    contraryEvidence: [], contraryEvidenceStatus: 'none_found' as const,
    invalidationConditions: report.invalidationConditions,
  })),
}

function fakeModel(delay = 0) {
  return {
    async *analyze({ signal, fetchFinancialContext }: { signal?: AbortSignal; fetchFinancialContext?: () => Promise<any> }): AsyncGenerator<ModelEvent> {
      if (fetchFinancialContext) {
        const context = await fetchFinancialContext()
        assert.equal(context.portfolioContext.position, null)
      }
      yield { type: 'text_delta', text: '正在分析' }
      if (delay) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      yield {
        type: 'completed', report,
        reportVersion: {
          kind: 'integrated',
          report: {
            kind: 'integrated', availability: 'available', status: 'completed',
            gaps: [], limitations: [], title: report.title,
          },
        },
      }
    },
  }
}

async function makeApp(storageKey: string, model = fakeModel(), concurrency = 2) {
  const database = testDatabases.get(storageKey) ?? createTestProductDatabase()
  testDatabases.set(storageKey, database)
  await database.runtimeSettingsRepository.save(
    { analysisConcurrency: concurrency }, new Date().toISOString(),
  )
  const app = buildApp({
    storageKey,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model,
  })
  await app.ready()
  return app
}

async function waitForStatus(app: Awaited<ReturnType<typeof makeApp>>, id: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/analyses/${id}` })
    if (response.json().status === expected) return response.json()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`analysis_not_${expected}`)
}

test('创建分析立即返回标识并自动保存完成报告、快照、事实和轨迹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-'))
  const app = await makeApp(join(dir, 'storage'))
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  assert.equal(created.statusCode, 202)
  const { analysisId, sessionId } = created.json()
  const completed = await waitForStatus(app, analysisId, 'completed')
  assert.equal(completed.report.title, report.title)

  const research = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
  assert.equal(research.statusCode, 200)
  assert.equal(research.json().snapshot.symbol, 'NVDA')
  assert.equal(research.json().snapshot.portfolioContext.position, null)
  assert.equal(typeof research.json().reportCreatedAt, 'string')
  const reportCreatedAt = research.json().reportCreatedAt
  assert.equal(research.json().facts[0].source, 'sina')
  assert.ok(research.json().trace.some((entry: { type: string }) => entry.type === 'status'))

  const versions = await app.inject({
    method: 'GET', url: `/api/research/${analysisId}/report-versions`,
  })
  assert.equal(versions.statusCode, 200)
  assert.equal(versions.json().items.length, 1)
  assert.equal(versions.json().items[0].version, 1)
  assert.equal(versions.json().items[0].kind, 'integrated')
  assert.equal(versions.json().items[0].report.title, report.title)
  assert.match(versions.json().items[0].payloadHash, /^[a-f0-9]{64}$/)

  const events = await app.inject({ method: 'GET', url: `/api/agent-sessions/${sessionId}/events` })
  assert.match(events.headers['content-type'] ?? '', /text\/event-stream/)
  assert.match(events.body, /event: completed/)
  await app.inject({
    method: 'PATCH', url: `/api/research/${analysisId}`, payload: { note: '新备注' },
  })
  const afterNote = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
  assert.equal(afterNote.json().reportCreatedAt, reportCreatedAt)
  assert.deepEqual(afterNote.json().report, research.json().report)
  await app.close()
})

test('创建 execution 冻结当前 settings revision 且后续修改不影响运行值', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ mainAgentToolRounds: 100 }, '2026-08-13T03:00:00.000Z')
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: fakeModel(50),
  })
  await app.ready()

  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'SNAPSHOT' },
  })).json()
  await database.runtimeSettingsRepository.save({ mainAgentToolRounds: 200 }, '2026-08-13T03:01:00.000Z')
  const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json()

  assert.equal(settings.current.values.mainAgentToolRounds, 200)
  assert.equal(settings.activeExecutions[0].executionId, created.executionId)
  assert.equal(settings.activeExecutions[0].values.mainAgentToolRounds, 100)
  await waitForStatus(app as any, created.analysisId, 'completed')
  await app.close()
})

test('模型尚未接入也能创建并读取主 Agent 完整初始生命周期', async () => {
  const database = createTestProductDatabase()
  let externalCalls = 0
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async () => { externalCalls += 1; throw new Error('must_not_start') },
    model: { async *analyze() { externalCalls += 1 } },
    modelConfigured: false,
  })
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  assert.equal(created.statusCode, 202)
  const body = created.json()
  assert.equal(body.existing, false)

  const research = await app.inject({ method: 'GET', url: `/api/research/${body.analysisId}` })
  assert.equal(research.statusCode, 200)
  const record = research.json()
  assert.equal(record.mainAgent.status, 'planning')
  assert.equal(record.mainAgent.execution.generation, 1)
  assert.equal(record.mainAgent.segments.length, 1)
  assert.equal(record.mainAgent.segments[0].ordinal, 1)
  assert.deepEqual(record.mainAgent.waitReason, {
    kind: 'database', target: '首次研究初始化', startedAt: record.createdAt,
  })
  assert.equal(record.mainAgent.events[0].type, 'runtime_context')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(externalCalls, 0)
  await app.close()
})

test('Runtime 状态事件与 waitReason 投影使用同一确定性值', async () => {
  const database = createTestProductDatabase()
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: fakeModel(10),
  })
  const created = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'WAIT' } })).json()
  await new Promise((resolve) => setTimeout(resolve, 2))
  const record = (await app.inject({ method: 'GET', url: `/api/research/${created.analysisId}` })).json()
  const running = record.mainAgent.events.find((event: { status?: string }) => event.status === 'running_model')
  assert.deepEqual(running.waitReason, record.mainAgent.waitReason)
  assert.equal(running.waitReason.target, '主模型响应')
  await app.close()
})

test('同一标的重复首次研究返回已有主 Agent 生命周期', async () => {
  const database = createTestProductDatabase()
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'aapl' } })).json()
  const repeated = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'AAPL' } })).json()
  assert.equal(repeated.existing, true)
  assert.equal(repeated.analysisId, first.analysisId)
  assert.equal(repeated.sessionId, first.sessionId)
  assert.equal(repeated.executionId, first.executionId)
  await app.close()
})

test('修改研究并发后立即启动尚未运行的排队 execution', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ analysisConcurrency: 1 }, '2026-08-13T03:00:00.000Z')
  let releaseFirst!: () => void
  const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve })
  let active = 0
  let maximumActive = 0
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: {
      async *analyze() {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (active === 1) await firstBarrier
        active -= 1
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'C1' } })).json()
  const second = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'C2' } })).json()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((await app.inject({ method: 'GET', url: `/api/analyses/${second.analysisId}` })).json().status, 'queued')

  await app.inject({ method: 'PUT', url: '/api/settings', payload: { analysisConcurrency: 2 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(maximumActive, 2)
  releaseFirst()
  await waitForStatus(app as any, first.analysisId, 'completed')
  await waitForStatus(app as any, second.analysisId, 'completed')
  await app.close()
})

test('即时 model/tool concurrency 对新旧 execution 使用同一全局上限', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({
    analysisConcurrency: 4, modelConcurrency: 2, toolConcurrency: 2,
  }, new Date().toISOString())
  let activeModels = 0
  let maxModels = 0
  let maxNewModelGlobalActive = 0
  let activeTools = 0
  let maxTools = 0
  let maxNewToolGlobalActive = 0
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol, signal) => {
      activeTools += 1
      maxTools = Math.max(maxTools, activeTools)
      if (symbol.startsWith('NEW')) maxNewToolGlobalActive = Math.max(maxNewToolGlobalActive, activeTools)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      activeTools -= 1
      return { symbol, facts: [fact], gaps: [], indicators: {} }
    },
    model: {
      async *analyze(input) {
        const release = await input.acquireModelSlot(input.signal)
        activeModels += 1
        maxModels = Math.max(maxModels, activeModels)
        if (String(input.symbol).startsWith('NEW')) {
          maxNewModelGlobalActive = Math.max(maxNewModelGlobalActive, activeModels)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        activeModels -= 1
        release()
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const oldExecutions = await Promise.all(['OLD1', 'OLD2'].map((symbol) => app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol },
  })))
  await app.inject({
    method: 'PUT', url: '/api/settings', payload: { modelConcurrency: 1, toolConcurrency: 1 },
  })
  const newExecutions = await Promise.all(['NEW1', 'NEW2'].map((symbol) => app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol },
  })))
  await Promise.all([...oldExecutions, ...newExecutions].map((response) => (
    waitForStatus(app as any, response.json().analysisId, 'completed')
  )))
  assert.ok(maxModels <= 2)
  assert.ok(maxTools <= 2)
  assert.equal(maxNewModelGlobalActive, 1)
  assert.equal(maxNewToolGlobalActive, 1)
  await app.close()
})

test('Runtime processing 单独耗尽 active budget 后进入确定性收口', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ researchActiveMinutes: 1 }, new Date().toISOString())
  let activeNow = 0
  let modelCalls = 0
  let toolCalls = 0
  const app = buildProductionApp({
    ...database,
    runtimeMinuteMs: 10,
    activeNow: () => activeNow,
    activeTimeoutSignal: () => new AbortController().signal,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async () => {
      toolCalls += 1
      activeNow = 11
      throw new Error('research_active_timeout')
    },
    model: {
      async *analyze() {
        modelCalls += 1
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'ABORT' } })).json()
  const partial = await waitForStatus(app as any, created.analysisId, 'partial')
  assert.equal(partial.report.title, report.title)
  assert.equal(toolCalls, 1)
  assert.equal(modelCalls, 1)
  await app.close()
})

test('Analysis 外部数据 active start 失败会释放工具槽且下一 execution 可运行', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({
    analysisConcurrency: 1, toolConcurrency: 1,
  }, new Date().toISOString())
  let timeoutSignals = 0
  let fetches = 0
  const app = buildProductionApp({
    ...database,
    activeTimeoutSignal: () => {
      timeoutSignals += 1
      if (timeoutSignals === 2) throw new Error('analysis_tool_active_start_failed')
      return new AbortController().signal
    },
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => {
      fetches += 1
      return { symbol, facts: [fact], gaps: [], indicators: {} }
    },
    model: fakeModel(),
  })
  await app.ready()
  const first = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'ACTIVEFAIL' },
  })).json()
  const failed = await waitForStatus(app as any, first.analysisId, 'failed')
  assert.equal(failed.error, 'analysis_tool_active_start_failed')

  const second = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'ACTIVENEXT' },
  })).json()
  await waitForStatus(app as any, second.analysisId, 'completed')
  assert.equal(fetches, 1)
  await app.close()
})

test('8 分钟 Runtime 加 8 分钟 provider 共用 10 分钟 active budget 并进入收口', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ researchActiveMinutes: 1 }, new Date().toISOString())
  let activeNow = 0
  let requests = 0
  const model = createPiModel({ fauxResponses: [
    () => {
      requests += 1
      activeNow = 16
      return fauxAssistantMessage('研究预算已经耗尽。')
    },
    () => {
      requests += 1
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', reportCandidate), { stopReason: 'toolUse' },
      )
    },
  ] })
  const app = buildProductionApp({
    ...database,
    runtimeMinuteMs: 10,
    activeNow: () => activeNow,
    activeTimeoutSignal: () => new AbortController().signal,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => {
      activeNow = 8
      return { symbol, facts: [fact], gaps: [], indicators: {} }
    },
    model,
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'SHARED' },
  })).json()
  const completed = await waitForStatus(app as any, created.analysisId, 'completed')
  assert.equal(completed.report.title, report.title)
  assert.equal(requests, 2)
  const research = (await app.inject({
    method: 'GET', url: `/api/research/${created.analysisId}`,
  })).json()
  const states = research.mainAgent.events
    .filter((event: { type?: string }) => event.type === 'status')
    .map((event: { status: string }) => event.status)
  assert.ok(states.includes('running_model'))
  assert.ok(states.includes('budget_exhausted'))
  assert.ok(states.includes('finalizing'))
  const finalizing = research.mainAgent.events.find(
    (event: { status?: string }) => event.status === 'finalizing',
  )
  assert.equal(finalizing.waitReason.target, '报告收口')
  await app.close()
})

test('settings snapshot 冻结失败时请求失败且不创建没有冻结契约的 execution', async () => {
  const database = createTestProductDatabase()
  database.agentEventRepository.createResearch = async () => { throw new Error('snapshot_failed') }
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: fakeModel(),
  })
  await app.ready()
  const response = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'SNAPFAIL' } })

  assert.equal(response.statusCode, 500)
  assert.deepEqual(await database.analysisRepository.listResearch(), [])
  assert.deepEqual(await database.agentEventRepository.listSessions(response.json().analysisId ?? ''), [])
  await app.close()
})

test('模型只接收 execution 创建时冻结的 Runtime settings', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ mainAgentToolRounds: 100 }, '2026-08-13T03:00:00.000Z')
  let receivedSettings: Record<string, unknown> | undefined
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: {
      async *analyze(input) {
        receivedSettings = input.runtimeSettings as Record<string, unknown>
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'FROZEN' },
  })).json()
  await database.runtimeSettingsRepository.save({ mainAgentToolRounds: 200 }, '2026-08-13T03:01:00.000Z')
  await waitForStatus(app as any, created.analysisId, 'completed')
  assert.equal(receivedSettings?.mainAgentToolRounds, 100)
  await app.close()
})

test('真实 Pi execution 冻结后修改 current 不改变运行轮次', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({
    mainAgentToolRounds: 1,
  }, '2026-08-13T03:02:00.000Z')
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: createPiModel({
      fauxResponses: [
        fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage(
          fauxToolCall('submit_analysis_report', reportCandidate), { stopReason: 'toolUse' },
        ),
      ],
      fauxTokensPerSecond: 1000,
    }),
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'REALPI' },
  })).json()
  await database.runtimeSettingsRepository.save({
    mainAgentToolRounds: 20,
  }, '2026-08-13T03:03:00.000Z')

  const completed = await waitForStatus(app as any, created.analysisId, 'completed')
  assert.equal(completed.report.title, report.title)
  assert.equal((await database.runtimeSettingsRepository.current()).values.mainAgentToolRounds, 20)
  assert.equal(
    (await database.runtimeSettingsRepository.getExecutionSnapshot(created.executionId))?.values.mainAgentToolRounds,
    1,
  )
  await app.close()
})

test('同一标的运行中重复创建返回原任务且不重复调用模型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-dedup-'))
  let calls = 0
  const model = fakeModel(50)
  const counted = { analyze(input: Parameters<typeof model.analyze>[0]) { calls += 1; return model.analyze(input) } }
  const app = await makeApp(join(dir, 'storage'), counted)
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  const second = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'nvda' } })).json()
  assert.equal(first.analysisId, second.analysisId)
  await waitForStatus(app, first.analysisId, 'completed')
  assert.equal(calls, 1)
  await app.close()
})

test('实例并发上限使额外任务排队', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-queue-'))
  const app = await makeApp(join(dir, 'storage'), fakeModel(60), 1)
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  const second = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'AMD' } })).json()
  const secondStatus = (await app.inject({ method: 'GET', url: `/api/analyses/${second.analysisId}` })).json()
  assert.equal(secondStatus.status, 'queued')
  await waitForStatus(app, first.analysisId, 'completed')
  await waitForStatus(app, second.analysisId, 'completed')
  await app.close()
})

test('execution wall 从创建时计时且排队超限后不启动任何外部调用', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({
    analysisConcurrency: 1, executionWallClockMinutes: 1,
  }, new Date().toISOString())
  let providerCalls = 0
  let toolCalls = 0
  const app = buildProductionApp({
    ...database,
    runtimeMinuteMs: 10,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => {
      toolCalls += 1
      return { symbol, facts: [fact], gaps: [], indicators: {} }
    },
    model: {
      async *analyze() {
        providerCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'WALL1' } })).json()
  const queued = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'WALL2' } })).json()

  const firstExpired = await waitForStatus(app as any, first.analysisId, 'budget_exhausted')
  assert.equal(firstExpired.error, 'execution_runtime_timeout')
  const expired = await waitForStatus(app as any, queued.analysisId, 'budget_exhausted')
  assert.equal(expired.error, 'execution_runtime_timeout')
  assert.equal(providerCalls, 1)
  assert.equal(toolCalls, 1)
  await app.close()
})

test('并发创建多个标的时运行任务数不超过实例上限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-concurrency-'))
  let active = 0
  let maximumActive = 0
  const app = await makeApp(join(dir, 'storage'), {
    async *analyze() {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      yield { type: 'completed' as const, report }
    },
  }, 2)
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: `T${index}` } })
  )))
  await Promise.all(created.map((response) => waitForStatus(app, response.json().analysisId, 'completed')))
  assert.equal(maximumActive, 2)
  await app.close()
})

test('并发调度在队列 claim 阻塞时仍不会超出实例上限', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ analysisConcurrency: 2 }, new Date().toISOString())
  const repository = database.analysisRepository
  const originalClaim = repository.claimNextQueued
  repository.claimNextQueued = async (updatedAt) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return originalClaim(updatedAt)
  }
  let active = 0
  let maximumActive = 0
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: {
      async *analyze() {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: `C${index}` } })
  )))
  await Promise.all(created.map((response) => waitForStatus(app as any, response.json().analysisId, 'completed')))
  assert.equal(maximumActive, 2)
  await app.close()
})

test('队列 claim 瞬时失败会归还槽位且后续创建可恢复调度', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ analysisConcurrency: 1 }, new Date().toISOString())
  const repository = database.analysisRepository
  const originalClaim = repository.claimNextQueued
  let failOnce = true
  repository.claimNextQueued = async (updatedAt) => {
    if (failOnce) { failOnce = false; throw new Error('temporary_claim_failure') }
    return originalClaim(updatedAt)
  }
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: fakeModel(),
  })
  await app.ready()
  const first = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'FAILONCE' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'RECOVER' } })
  await waitForStatus(app as any, first.json().analysisId, 'completed')
  await waitForStatus(app as any, second.json().analysisId, 'completed')
  await app.close()
})

test('running 轨迹写入失败会中断已领取任务并恢复后续调度', async () => {
  const database = createTestProductDatabase()
  await database.runtimeSettingsRepository.save({ analysisConcurrency: 1 }, new Date().toISOString())
  const repository = database.agentEventRepository
  const originalAppend = repository.append
  let failOnce = true
  repository.append = async (input) => {
    if (failOnce && input.event.status === 'planning') {
      failOnce = false
      throw new Error('running_trace_write_failed')
    }
    return originalAppend(input)
  }
  let modelCalls = 0
  const model = fakeModel()
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: { analyze(input: Parameters<typeof model.analyze>[0]) { modelCalls += 1; return model.analyze(input) } },
  })
  await app.ready()
  const first = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'TRACEFAIL' } })
  const second = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'AFTERFAIL' } })
  const interrupted = await waitForStatus(app as any, first.json().analysisId, 'interrupted')
  assert.equal(interrupted.error, 'analysis_running_trace_failed')
  await waitForStatus(app as any, second.json().analysisId, 'completed')
  assert.equal(modelCalls, 1)
  await app.close()
})

test('取消运行任务会以 stopping → stopped 统一收敛模型与生命周期投影', async () => {
  const database = createTestProductDatabase()
  let modelStarted!: () => void
  let releaseSettle!: () => void
  const started = new Promise<void>((resolve) => { modelStarted = resolve })
  const settle = new Promise<void>((resolve) => { releaseSettle = resolve })
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze(input) {
        modelStarted()
        await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }))
        await settle
        yield { type: 'cancelled' as const }
      },
    },
  })
  await app.ready()
  const { analysisId } = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  await started
  let cancelSettled = false
  const cancelling = app.inject({ method: 'POST', url: `/api/analyses/${analysisId}/cancel` })
    .finally(() => { cancelSettled = true })
  await waitForStatus(app as any, analysisId, 'stopping')
  assert.equal(cancelSettled, false)
  releaseSettle()
  const cancelled = await cancelling
  assert.equal(cancelled.statusCode, 202)
  await waitForStatus(app, analysisId, 'stopped')
  const research = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
  assert.deepEqual(research.json().trace
    .filter((entry: { status?: string }) => ['stopping', 'stopped'].includes(entry.status ?? ''))
    .map((entry: { status: string }) => entry.status), ['stopping', 'stopped'])
  assert.equal(research.json().status, 'stopped')
  assert.equal(research.json().mainAgent.status, 'stopped')
  await app.close()
})

test('取消已领取但尚未登记 controller 的任务会停止且不启动外部工作', async () => {
  const database = createTestProductDatabase()
  const originalSnapshot = database.runtimeSettingsRepository.getExecutionSnapshot
  let snapshotRequested!: () => void
  let releaseSnapshot!: () => void
  const requested = new Promise<void>((resolve) => { snapshotRequested = resolve })
  const release = new Promise<void>((resolve) => { releaseSnapshot = resolve })
  database.runtimeSettingsRepository.getExecutionSnapshot = async (executionId) => {
    snapshotRequested()
    await release
    return originalSnapshot(executionId)
  }
  let externalCalls = 0
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async () => {
      externalCalls += 1
      return { symbol: 'RACE', facts: [fact], gaps: [] }
    },
    model: { async *analyze() { externalCalls += 1; yield { type: 'completed' as const, report } } },
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'RACE' },
  })).json()
  await requested
  const response = await app.inject({ method: 'POST', url: `/api/analyses/${created.analysisId}/cancel` })
  assert.equal(response.statusCode, 202)
  releaseSnapshot()
  await waitForStatus(app as any, created.analysisId, 'stopped')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(externalCalls, 0)
  const research = (await app.inject({
    method: 'GET', url: `/api/research/${created.analysisId}`,
  })).json()
  assert.deepEqual(research.trace
    .filter((event: { status?: string }) => ['stopping', 'stopped'].includes(event.status ?? ''))
    .map((event: { status: string }) => event.status), ['stopping', 'stopped'])
  await app.close()
})

test('重启后未完成任务标记为中断且不会自动执行', async () => {
  const database = createTestProductDatabase()
  const analysisId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await database.agentEventRepository.createResearch({
    analysisId,
    sessionId,
    executionId: crypto.randomUUID(),
    symbol: 'NVDA',
    status: 'queued',
    operationId: `session:${sessionId}:created`,
    event: { type: 'status', status: 'queued' },
    createdAt: new Date().toISOString(),
  })
  let calls = 0
  const second = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: { async *analyze() { calls += 1; yield { type: 'completed' as const, report } }, },
  })
  await second.ready()
  const status = (await second.inject({ method: 'GET', url: `/api/analyses/${analysisId}` })).json()
  assert.equal(status.status, 'interrupted')
  const replay = await second.inject({
    method: 'GET', url: `/api/agent-sessions/${sessionId}/events`,
  })
  assert.match(replay.body, /event: interrupted/)
  assert.match(replay.body, new RegExp(`id: ${sessionId}:2`))
  assert.equal(calls, 0)
  await second.close()
})

test('研究记录可以查询、标记、备注并按共享引用安全删除事实', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-research-'))
  const app = await makeApp(join(dir, 'storage'))
  const first = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  await waitForStatus(app, first.analysisId, 'completed')
  const second = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  await waitForStatus(app, second.analysisId, 'completed')

  const list = await app.inject({ method: 'GET', url: '/api/research?symbol=NVDA' })
  assert.equal(list.json().records.length, 2)
  const updated = await app.inject({
    method: 'PATCH', url: `/api/research/${first.analysisId}`,
    payload: { starred: true, note: '关注财报后的趋势确认' },
  })
  assert.equal(updated.json().starred, true)
  assert.equal(updated.json().note, '关注财报后的趋势确认')

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/research/${first.analysisId}` })).statusCode, 204)
  const remaining = await app.inject({ method: 'GET', url: `/api/research/${second.analysisId}` })
  assert.equal(remaining.statusCode, 200)
  assert.equal(remaining.json().facts[0].id, fact.id)

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/research/${second.analysisId}` })).statusCode, 204)
  const missing = await app.inject({ method: 'GET', url: `/api/research/${second.analysisId}` })
  assert.equal(missing.statusCode, 404)
  await app.close()
})

test('无持仓时宿主移除个性化建议且限制报告保存为部分完成', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-partial-'))
  const partialReport = {
    ...report,
    personalImpact: '建议降低仓位',
    conditionalSuggestion: '若下跌则减仓',
    limitations: ['财报输入缺失'],
  }
  const app = await makeApp(join(dir, 'storage'), {
    async *analyze() { yield { type: 'completed' as const, report: partialReport } },
  })
  const { analysisId } = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  const completed = await waitForStatus(app, analysisId, 'partial')
  assert.equal(completed.report.personalImpact, null)
  assert.equal(completed.report.conditionalSuggestion, null)
  assert.deepEqual(completed.report.limitations, ['财报输入缺失'])
  await app.close()
})

test('分析持仓语境使用组合内全部标的行情计算占比但不披露其他标的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-portfolio-'))
  let capturedContext: any
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    fetchMarketPrices: async (symbols) => {
      assert.deepEqual(symbols.sort(), ['AMD', 'NVDA'])
      return { NVDA: 200, AMD: 100 }
    },
    model: {
      async *analyze({ fetchFinancialContext }: any) {
        capturedContext = (await fetchFinancialContext()).portfolioContext
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 2, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/positions/AMD', payload: { quantity: 6, averageCost: 80 } })
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')

  assert.equal(capturedContext.position.portfolioWeight, 435 / 1035)
  assert.deepEqual(Object.keys(capturedContext.position).includes('otherPositions'), false)
  assert.deepEqual(capturedContext.portfolio, {
    totalMarketValue: 1035, largestPositionWeight: 600 / 1035, topThreeWeight: 1, positionCount: 2,
    pricedPositionCount: 2, unpricedPositionCount: 0,
  })
  await app.close()
})

test('组合辅助行情失败时保留当前标的分析并明确个性化限制', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-portfolio-gap-'))
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    fetchMarketPrices: async () => { throw new Error('quotes_down') },
    model: { async *analyze() { yield { type: 'completed' as const, report } } },
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 2, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/positions/AMD', payload: { quantity: 6, averageCost: 80 } })
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  const result = await waitForStatus(app as any, created.json().analysisId, 'partial')
  assert.ok(result.report.limitations.some((item: string) => item.includes('组合内部分持仓')))
  assert.equal(result.snapshot.portfolioContext.position.marketValue, 435)
  assert.equal(result.snapshot.portfolioContext.position.portfolioWeight, null)
  await app.close()
})

test('关键行情、财报和新闻缺失时宿主强制形成受限报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-gaps-'))
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, facts: [],
      gaps: ['quote', 'history', 'fundamentals', 'valuation', 'news'].map((capability) => ({ capability, reason: 'all_sources_unavailable' })),
    }),
    model: { async *analyze() { yield { type: 'completed' as const, report } } },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  const result = await waitForStatus(app as any, created.json().analysisId, 'partial')
  assert.equal(result.report.trend, '无法生成走势判断')
  assert.equal(result.report.valuation, null)
  assert.ok(result.report.limitations.some((item: string) => item.includes('新闻')))
  await app.close()
})

test('工具补查返回的事实进入研究证据集合', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-tool-fact-'))
  const extraFact = { ...fact, id: 'fact:tool:extra', type: 'news' }
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze() {
        yield { type: 'trace' as const, entry: { type: 'tool_result' as const, name: 'fetch_financial_context', result: { facts: [extraFact] }, isError: false } }
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = await app.inject({ method: 'GET', url: `/api/research/${created.json().analysisId}` })
  assert.ok(research.json().facts.some((item: { id: string }) => item.id === extraFact.id))
  await app.close()
})

test('Runtime 按模型请求、工具批次与报告收口持久化真实状态序列', async () => {
  const database = createTestProductDatabase()
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze() {
        yield { type: 'lifecycle' as const, status: 'running_model' as const, operationId: 'model-request-1' }
        yield { type: 'lifecycle' as const, status: 'running_tools' as const, operationId: 'tool-batch-1' }
        yield { type: 'trace' as const, entry: {
          type: 'tool_call' as const, name: 'fetch_financial_context', input: {}, operationId: 'tool-call-1',
        } }
        yield { type: 'trace' as const, entry: {
          type: 'tool_result' as const, name: 'fetch_financial_context', result: { facts: [] },
          isError: false, operationId: 'tool-result-1',
        } }
        yield { type: 'lifecycle' as const, status: 'running_model' as const, operationId: 'model-request-2' }
        yield {
          type: 'lifecycle' as const,
          status: 'waiting_for_specialists' as const,
          operationId: 'specialist-wait-1',
        }
        yield { type: 'lifecycle' as const, status: 'finalizing' as const, operationId: 'report-closure' }
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'SEQUENCE' },
  })).json()
  await waitForStatus(app as any, created.analysisId, 'completed')
  const research = (await app.inject({
    method: 'GET', url: `/api/research/${created.analysisId}`,
  })).json()
  assert.deepEqual(research.mainAgent.events
    .filter((event: { type?: string }) => event.type === 'status')
    .map((event: { status: string }) => event.status), [
    'planning', 'running_model', 'running_model', 'running_tools',
    'running_model', 'waiting_for_specialists', 'finalizing', 'completed',
  ])
  for (const event of research.mainAgent.events.filter(
    (item: { status?: string }) => [
      'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing',
    ].includes(item.status ?? ''),
  )) assert.ok(event.waitReason?.startedAt)
  await app.close()
})

test('Runtime 重放同一 operationId 不追加第二条业务事件', async () => {
  const app = buildApp({
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze(): AsyncGenerator<ModelEvent> {
        const replayed = {
          type: 'tool_call' as const,
          name: 'fetch_financial_context',
          input: { symbol: 'NVDA' },
          operationId: 'tool:provider-call-1:call',
        }
        yield { type: 'trace', entry: replayed }
        yield { type: 'trace', entry: replayed }
        yield { type: 'completed', report, operationId: 'tool:provider-report-1:report' }
      },
    },
  })
  await app.ready()
  const created = (await app.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' },
  })).json() as { analysisId: string }
  await waitForStatus(app as any, created.analysisId, 'completed')
  const research = (await app.inject({
    method: 'GET', url: `/api/research/${created.analysisId}`,
  })).json()
  assert.equal(research.trace.filter((entry: { operationId?: string }) => (
    entry.operationId === 'tool:provider-call-1:call'
  )).length, 1)
  await app.close()
})

test('分析轨迹永久保存系统指令、用户语境、模型用量和最终状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-trace-'))
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze(input: any) {
        yield { type: 'trace' as const, entry: { type: 'system_prompt' as const, content: input.systemPrompt } }
        yield { type: 'trace' as const, entry: { type: 'user_input' as const, content: input.userPrompt } }
        yield { type: 'trace' as const, entry: {
          type: 'model_event' as const, event: { type: 'thinking_delta', delta: '隐藏推理' },
        } }
        yield { type: 'completed' as const, report, usage: { input: 100, output: 20, cost: 0.01 }, stopReason: 'toolUse' }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = (await app.inject({ method: 'GET', url: `/api/research/${created.json().analysisId}` })).json()
  assert.ok(research.trace.some((entry: { type: string }) => entry.type === 'system_prompt'))
  assert.ok(research.trace.some((entry: { type: string }) => entry.type === 'user_input'))
  assert.ok(research.trace.some((entry: { type: string; stopReason?: string }) => entry.type === 'model_completed' && entry.stopReason === 'toolUse'))
  assert.equal(JSON.stringify(research.trace).includes('"cost":0.01'), true)
  assert.equal(JSON.stringify(research.trace).includes('隐藏推理'), false)
  await app.close()
})

test('首次研究把系统生成的 Runtime Context 追加到上下文末尾且不伪装为用户问题', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-first-research-runtime-context-'))
  let modelInput: Record<string, unknown> | undefined
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model: {
      async *analyze(input: any) {
        modelInput = input
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()

  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = (await app.inject({
    method: 'GET', url: `/api/research/${created.json().analysisId}`,
  })).json()

  assert.match(String(modelInput?.systemPrompt), /^你是个人美股研究助手/)
  assert.equal(modelInput?.userPrompt, undefined)
  assert.deepEqual(modelInput?.runtimeContext && {
    role: (modelInput.runtimeContext as any).role,
    generatedBy: (modelInput.runtimeContext as any).generatedBy,
    isUserInput: (modelInput.runtimeContext as any).isUserInput,
    symbol: (modelInput.runtimeContext as any).content.symbol,
  }, {
    role: 'runtime_context', generatedBy: 'product_runtime', isUserInput: false, symbol: 'NVDA',
  })
  assert.ok(research.trace.some((entry: { type: string }) => entry.type === 'runtime_context'))
  assert.equal(research.trace.some((entry: { type: string }) => entry.type === 'user_input'), false)
  await app.close()
})

test('首次研究起始资料完整描述能力、工具与报告目标且不注入预算', async () => {
  const bars = Array.from({ length: 24 }, (_, index) => ({
    ...fact, id: `fact:context-bar:${index}`, type: 'daily_bar',
    value: { date: `2026-07-${String(index + 1).padStart(2, '0')}`, close: 190 + index },
    observedAt: `2026-07-${String(index + 1).padStart(2, '0')}`,
  }))
  let runtimeContext: any
  const app = buildApp({
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, facts: [fact, ...bars], gaps: [{ capability: 'news', reason: 'source_unavailable' }],
      quote: { value: 217.5, adopted_source: 'sina', sources: [{ source: 'sina', status: 'ok' }] },
      history: { items: bars, adopted_source: 'alpaca', sources: [{ source: 'alpaca', status: 'ok' }] },
      fundamentals: { value: { quarters: [{ period: 'CY2026Q2' }], annuals: [], derived_metrics: [] } },
      valuation: null,
    }),
    model: {
      async *analyze(input: any) {
        runtimeContext = input.runtimeContext?.content
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'partial')

  assert.equal(runtimeContext.symbol, 'NVDA')
  assert.equal(runtimeContext.analysisPeriod, '未来一至四周')
  assert.equal(runtimeContext.marketSummary.currentPrice, 217.5)
  assert.equal(runtimeContext.recentDailyBars.length, 20)
  assert.equal(runtimeContext.latestFinancialPeriod, 'CY2026Q2')
  assert.equal(runtimeContext.capabilityStatus.quote.status, 'available')
  assert.equal(runtimeContext.capabilityStatus.history.status, 'available')
  assert.equal(runtimeContext.capabilityStatus.news.status, 'unavailable')
  assert.equal(runtimeContext.capabilityStatus.valuation.status, 'unavailable')
  assert.deepEqual(runtimeContext.availableTools.map(({ name }: { name: string }) => name), [
    'fetch_financial_context', 'analyze_financials', 'submit_analysis_report',
  ])
  assert.deepEqual(runtimeContext.specialistCapabilities, [
    { domain: 'news', responsibility: '核实消息、公司事件及相反证据' },
    { domain: 'fundamental_valuation', responsibility: '解释财务表现、估值输入与数据缺口' },
    { domain: 'technical', responsibility: '解释多周期量价与确定性技术指标' },
  ])
  assert.match(runtimeContext.finalReportGoal, /候选结构化综合报告/)
  assert.ok(runtimeContext.personalContext)
  assert.doesNotMatch(JSON.stringify(runtimeContext), /mainAgentToolRounds|researchActiveMinutes|elapsed|budget/i)
  await app.close()
})

test('完整历史写入冻结快照且首次研究起始资料提供最近二十条日线', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-model-context-'))
  const bars = Array.from({ length: 180 }, (_, index) => ({
    ...fact, id: `fact:bar:${index}`, type: 'daily_bar',
    value: { date: `day-${index}`, close: index }, observedAt: `day-${index}`,
  }))
  let modelFactCount = 0
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact, ...bars], gaps: [], indicators: {} }),
    model: {
      async *analyze({ fetchFinancialContext }: any) {
        const context = await fetchFinancialContext()
        modelFactCount = context.facts.filter((item: { type: string }) => item.type === 'daily_bar').length
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = (await app.inject({ method: 'GET', url: `/api/research/${created.json().analysisId}` })).json()
  assert.equal(research.snapshot.facts.filter((item: { type: string }) => item.type === 'daily_bar').length, 180)
  assert.equal(modelFactCount, 20)
  await app.close()
})

test('完整多期财报写入快照但模型只收到决策窗口和可追溯依据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-financial-window-'))
  const periods = ['CY2026Q1', 'CY2025Q4', 'CY2025Q3', 'CY2025Q2', 'CY2025Q1', 'CY2024Q4']
  const financialFacts = periods.map((period) => ({
    ...fact, id: `fact:NVDA:reported:quarter:${period}:revenue`, type: 'reported_financial',
    value: { classification: 'reported', metric: 'revenue', period, value: 100 }, observedAt: period,
  }))
  const derived = {
    ...fact, id: 'fact:NVDA:derived:quarter:CY2026Q1:revenue_yoy', type: 'derived_financial_metric',
    value: {
      classification: 'derived', metric: 'revenue_yoy', period: 'CY2026Q1', value: 0.25,
      inputFactIds: [financialFacts[0].id, financialFacts[4].id],
    },
  }
  const quarters = periods.map((period, index) => ({
    period, values: { revenue: { value: 100 + index, fact_id: financialFacts[index].id } },
  }))
  let modelContext: any
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, facts: [fact, ...financialFacts, derived], gaps: [],
      fundamentals: { value: {
        quarters, annuals: [{ period: 'CY2025' }, { period: 'CY2024' }, { period: 'CY2023' }, { period: 'CY2022' }],
        ttm: { status: 'available', values: {} },
        derived_metrics: [{
          fact_id: derived.id, metric: 'revenue_yoy', scope: 'quarter', period: 'CY2026Q1', value: 0.25,
          input_fact_ids: [financialFacts[0].id, financialFacts[4].id],
        }], quality_flags: [],
      } },
    }),
    model: {
      async *analyze({ fetchFinancialContext }: any) {
        modelContext = await fetchFinancialContext()
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = (await app.inject({ method: 'GET', url: `/api/research/${created.json().analysisId}` })).json()

  assert.equal(research.snapshot.fundamentals.value.quarters.length, 6)
  assert.deepEqual(modelContext.financials.quarters.map((item: any) => item.period), ['CY2026Q1', 'CY2025Q4', 'CY2025Q1'])
  assert.deepEqual(modelContext.financials.annuals.map((item: any) => item.period), ['CY2025', 'CY2024', 'CY2023'])
  assert.ok(modelContext.facts.some((item: any) => item.id === derived.id))
  assert.ok(modelContext.facts.some((item: any) => item.id === financialFacts[4].id))
  assert.equal(modelContext.facts.some((item: any) => item.id === financialFacts[2].id), false)
  await app.close()
})

test('金融上下文事件包含主备来源切换信息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-degraded-event-'))
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, facts: [fact], gaps: [],
      quote: { degraded: true, sources: [{ source: 'primary', status: 'failed' }, { source: 'backup', status: 'ok' }] },
    }),
    model: fakeModel(),
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  const research = (await app.inject({ method: 'GET', url: `/api/research/${created.json().analysisId}` })).json()
  const contextEvent = research.trace.find((entry: { type: string }) => entry.type === 'financial_context')
  assert.deepEqual(contextEvent.degradedSources, [{
    capability: 'quote', sources: [{ source: 'primary', status: 'failed' }, { source: 'backup', status: 'ok' }],
  }])
  assert.deepEqual(contextEvent.capabilities, [{
    capability: 'quote', adoptedSource: null, acceptedCount: 0,
    sources: [{ source: 'primary', status: 'failed' }, { source: 'backup', status: 'ok' }],
  }])
  await app.close()
})

test('系统指令要求先取冻结上下文、逐项引用依据并按缺口降级', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-prompt-'))
  let systemPrompt = ''
  const app = buildApp({
    storageKey: join(dir, 'storage'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [] }),
    model: {
      async *analyze(input: any) {
        systemPrompt = input.systemPrompt
        yield { type: 'completed' as const, report }
      },
    },
  })
  await app.ready()
  const created = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })
  await waitForStatus(app as any, created.json().analysisId, 'completed')
  assert.match(systemPrompt, /fetch_financial_context/)
  assert.match(systemPrompt, /keyJudgments/)
  assert.match(systemPrompt, /缺行情不得判断走势/)
  assert.match(systemPrompt, /财报增长率.*由宿主程序计算/)
  assert.match(systemPrompt, /不重新计算/)
  await app.close()
})
