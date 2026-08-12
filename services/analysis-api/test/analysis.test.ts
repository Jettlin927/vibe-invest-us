import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ModelEvent } from '../src/model.js'
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
      yield { type: 'completed', report }
    },
  }
}

async function makeApp(storageKey: string, model = fakeModel(), concurrency = 2) {
  const app = buildApp({
    storageKey,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, facts: [fact], gaps: [], indicators: {} }),
    model,
    analysisConcurrency: concurrency,
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
  const { analysisId } = created.json()
  const completed = await waitForStatus(app, analysisId, 'completed')
  assert.equal(completed.report.title, report.title)

  const research = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
  assert.equal(research.statusCode, 200)
  assert.equal(research.json().snapshot.symbol, 'NVDA')
  assert.equal(research.json().snapshot.portfolioContext.position, null)
  assert.equal(research.json().facts[0].source, 'sina')
  assert.ok(research.json().trace.some((entry: { type: string }) => entry.type === 'status'))

  const events = await app.inject({ method: 'GET', url: `/api/analyses/${analysisId}/events` })
  assert.match(events.headers['content-type'] ?? '', /text\/event-stream/)
  assert.match(events.body, /event: completed/)
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
    analysisConcurrency: 2,
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
    analysisConcurrency: 1,
  })
  await app.ready()
  const first = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'FAILONCE' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'RECOVER' } })
  await waitForStatus(app as any, first.json().analysisId, 'completed')
  await waitForStatus(app as any, second.json().analysisId, 'completed')
  await app.close()
})

test('取消运行任务会停止模型并保存取消轨迹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-cancel-'))
  const app = await makeApp(join(dir, 'storage'), fakeModel(1000), 1)
  const { analysisId } = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cancelled = await app.inject({ method: 'POST', url: `/api/analyses/${analysisId}/cancel` })
  assert.equal(cancelled.statusCode, 202)
  await waitForStatus(app, analysisId, 'cancelled')
  const research = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
  assert.ok(research.json().trace.some((entry: { status?: string }) => entry.status === 'cancelled'))
  await app.close()
})

test('重启后未完成任务标记为中断且不会自动执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-analysis-restart-'))
  const storageKey = join(dir, 'restart')
  const first = await makeApp(storageKey, fakeModel(1000), 0)
  const { analysisId } = (await first.inject({ method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' } })).json()
  await first.close()
  let calls = 0
  const second = await makeApp(storageKey, { async *analyze() { calls += 1; yield { type: 'completed' as const, report } } })
  const status = (await second.inject({ method: 'GET', url: `/api/analyses/${analysisId}` })).json()
  assert.equal(status.status, 'interrupted')
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
  await app.close()
})

test('完整历史写入冻结快照但只向模型提供最近十条日线', async () => {
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
  assert.equal(modelFactCount, 10)
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
