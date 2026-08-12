import assert from 'node:assert/strict'
import test from 'node:test'

import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { defaultRuntimeSettings } from '@vibe-invest/contracts'

import { createPiModel } from '../src/model.js'
import { analysisModelTools, financialSpecialistTools } from '../src/tools.js'

const facts = [{
  id: 'fact:nvda:price:2026-08-12',
  type: 'quote',
  value: 217.5,
  observedAt: '2026-08-12T13:48:38Z',
  fetchedAt: '2026-08-12T14:00:00Z',
  source: 'sina',
  sourceReference: 'https://example.com/nvda',
}]

const validReport = {
  title: 'NVDA 一至四周综合分析',
  marketState: '价格处于短期均线之上。',
  trend: '未来一至四周偏强震荡。',
  drivers: ['近期量价保持强势。'],
  supportingEvidence: ['fact:nvda:price:2026-08-12'],
  contraryEvidence: ['fact:nvda:price:2026-08-12'],
  scenarios: [{ name: '延续', condition: '站稳当前价格', outcome: '趋势延续' }],
  invalidationConditions: ['跌破关键均线'],
  valuation: null,
  personalImpact: null,
  conditionalSuggestion: null,
  limitations: [],
  keyJudgments: [{ judgment: '短期趋势偏强', evidence: ['fact:nvda:price:2026-08-12'] }],
}

function runtimeSettings(overrides: Partial<typeof defaultRuntimeSettings> = {}) {
  return { ...defaultRuntimeSettings, ...overrides }
}

test('主分析模型和财报专家使用不同的显式工具集', () => {
  assert.deepEqual(analysisModelTools.map((tool) => tool.name), [
    'fetch_financial_context', 'analyze_financials', 'submit_analysis_report',
  ])
  assert.deepEqual(financialSpecialistTools.map((tool) => tool.name), [
    'search_news_by_keyword', 'get_technical_indicators',
  ])
})

test('宽松报告允许证据和情景数组为空', async () => {
  const sparseReport = {
    ...validReport,
    drivers: [], supportingEvidence: [], contraryEvidence: [], scenarios: [],
    invalidationConditions: [], keyJudgments: [],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', sparseReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('所有工具参数均可省略且宿主提供当前任务默认值', async () => {
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', {}), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async (symbol) => ({ facts, symbol }),
  })) events.push(event)
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') {
    assert.equal(completed.report.title, '')
    assert.deepEqual(completed.report.keyJudgments, [])
  }
})

function successResponses(report = validReport) {
  return [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxText('分析材料已经准备完成。'),
      fauxToolCall('submit_analysis_report', report),
    ], { stopReason: 'toolUse' }),
  ]
}

test('Pi Model 通过只读工具流式生成结构化报告和完整轨迹', async () => {
  const logs: unknown[] = []
  const model = createPiModel({ fauxResponses: successResponses(), log: (entry) => logs.push(entry) })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    executionId: 'pi-model-test-execution',
    symbol: 'NVDA', systemPrompt: '只引用给定事实。', userPrompt: '分析 NVDA。',
    knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)

  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') assert.deepEqual(completed.report, validReport)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_call'))
  assert.ok(events.some((event) => event.type === 'trace'
    && event.entry.operationId.startsWith('execution:pi-model-test-execution:tool:')))
  assert.ok(events.some((event) => event.type === 'text_delta'))
  assert.equal(JSON.stringify(logs).includes('217.5'), false)
})

test('Pi Model 拒绝不存在的报告依据并允许模型修正后重交', async () => {
  const badReport = { ...validReport, supportingEvidence: ['fact:not-found'] }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', badReport), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'private prompt', userPrompt: 'private holding',
    knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result'
    && event.entry.name === 'submit_analysis_report' && event.entry.isError))
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('Pi Model 在关键判断依据不存在时不接受报告', async () => {
  const badReport = {
    ...validReport,
    keyJudgments: [{ judgment: '无法追溯的结论', evidence: ['fact:not-found'] }],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }), { stopReason: 'toolUse' }),
    ...Array.from({ length: 5 }, () => fauxAssistantMessage(
      fauxToolCall('submit_analysis_report', badReport), { stopReason: 'toolUse' },
    )),
  ] })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      runtimeSettings: runtimeSettings({ mainAgentToolRounds: 5 }),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
      knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  }, /analysis_turn_limit/)
})

test('Pi Model 为结构不完整的报告补齐安全默认值', async () => {
  const malformed = { ...validReport } as Record<string, unknown>
  delete malformed.scenarios
  const model = createPiModel({ fauxResponses: successResponses(malformed as typeof validReport) })
  const events = []
  for await (const event of model.analyze({
      runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
      knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') assert.deepEqual(completed.report.scenarios, [])
})

test('Pi Model 收到取消后快速停止等待', async () => {
  const model = createPiModel({
    fauxResponses: [fauxAssistantMessage(fauxText('很长的分析'.repeat(100)))],
    fauxTokensPerSecond: 1,
  })
  const controller = new AbortController()
  const startedAt = performance.now()
  const consume = async () => {
    for await (const _event of model.analyze({
      runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }), signal: controller.signal,
    })) { /* consume */ }
  }
  setTimeout(() => controller.abort(), 20)
  await consume()
  assert.ok(performance.now() - startedAt < 250)
})

test('Pi Model 工具超时形成可引用失败事实', async () => {
  const timeoutFact = 'fact:tool-error:fetch_financial_context:1'
  const report = {
    ...validReport,
    trend: '关键行情不可用，无法判断趋势。',
    supportingEvidence: [timeoutFact],
    contraryEvidence: [timeoutFact],
    keyJudgments: [{ judgment: '数据不可用', evidence: [timeoutFact] }],
    limitations: ['金融数据工具超时'],
  }
  const model = createPiModel({ fauxResponses: successResponses(report), toolTimeoutMs: 10 })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: [],
    fetchFinancialContext: async (_symbol, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { facts: [] }
    },
  })) events.push(event)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result' && event.entry.isError))
})

test('Pi Model 不允许工具越过当前分析标的', async () => {
  const deniedFact = 'fact:tool-error:fetch_financial_context:1'
  const deniedReport = {
    ...validReport,
    supportingEvidence: [deniedFact], contraryEvidence: [deniedFact],
    keyJudgments: [{ judgment: '越权补查已拒绝', evidence: [deniedFact] }],
    limitations: ['只允许补查当前标的'],
  }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', { symbol: 'AMD' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', deniedReport), { stopReason: 'toolUse' }),
  ] })
  let called = false
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: [],
    fetchFinancialContext: async () => { called = true; return { facts: [] } },
  })) events.push(event)
  assert.equal(called, false)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result' && event.entry.isError))
})

test('Pi Model 允许自由思考并按需调用独立财报专家后提交报告', async () => {
  const specialistText = '财报专家结论：收入改善，但只引用现有事实。'
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxText('我先判断需要哪些材料。')),
    fauxAssistantMessage(fauxToolCall('analyze_financials', { symbol: 'NVDA' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxText(specialistText)),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: '可自由规划，只能使用给定工具。', userPrompt: '分析 NVDA。',
    knownFacts: facts,
    fetchFinancialContext: async () => ({
      facts, financials: { quarters: [{ period: 'CY2026Q1' }], ttm: { status: 'available' } },
    }),
  })) events.push(event)

  assert.ok(events.some((event) => event.type === 'text_delta' && event.text.includes('判断需要')))
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_call'
    && event.entry.name === 'analyze_financials'))
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result'
    && event.entry.name === 'analyze_financials' && JSON.stringify(event.entry.result).includes(specialistText)))
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('财报专家可自由调用新闻和技术指标工具并把新增事实交回主模型', async () => {
  const newsFact = {
    ...facts[0]!, id: 'fact:news:query', type: 'news', observedAt: '2026-08-01T00:00:00.000Z',
  }
  const indicatorFact = { ...facts[0]!, id: 'fact:indicator:query', type: 'indicators' }
  const logs: Array<Record<string, unknown>> = []
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_by_keyword', { keyword: 'NAND' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('get_technical_indicators', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxText('综合补查事实后的财报分析。')),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', {
      ...validReport,
      supportingEvidence: [newsFact.id],
      keyJudgments: [{ judgment: '补查结果可追溯', evidence: [indicatorFact.id] }],
    }), { stopReason: 'toolUse' }),
  ], now: () => new Date('2026-08-13T00:00:00.000Z'), log: (entry) => logs.push(entry) })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings({ reportFreshnessDays: 3, compactionReserveTokens: 1_000_000 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => ({ facts: [newsFact] }),
    fetchTechnicalIndicators: async (symbol, startDate, endDate) => {
      assert.equal(symbol, 'NVDA')
      assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/)
      assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/)
      return { facts: [indicatorFact] }
    },
  })) events.push(event)

  const specialistResult = events.find((event) => event.type === 'trace'
    && event.entry.type === 'tool_result' && event.entry.name === 'analyze_financials')
  assert.match(JSON.stringify(specialistResult), /fact:news:query/)
  assert.match(JSON.stringify(specialistResult), /fact:indicator:query/)
  assert.ok(logs.some((entry) => entry.type === 'compaction' && entry.specialist === true))
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') {
    assert.match(completed.report.title, /^⚠ 数据时效提醒/)
    assert.ok(completed.report.limitations.some((item) => item.includes(newsFact.id)))
  }
})

test('真实 Pi 仅在含工具调用的 Turn 消耗主与专项冻结轮次', async () => {
  const main = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxText('继续一')),
    fauxAssistantMessage(fauxText('继续二')),
    fauxAssistantMessage([
      fauxToolCall('fetch_financial_context', {}),
      fauxToolCall('submit_analysis_report', validReport),
    ], { stopReason: 'toolUse' }),
  ] })
  const mainEvents = []
  for await (const event of main.analyze({
    executionId: 'rounds-main', runtimeSettings: runtimeSettings({ mainAgentToolRounds: 1 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
  })) mainEvents.push(event)
  assert.ok(mainEvents.some((event) => event.type === 'completed'))

  const specialist = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', {
      ...validReport, limitations: ['专项 Agent 达到冻结轮次上限'],
    }), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of specialist.analyze({
    executionId: 'rounds-specialist',
    runtimeSettings: runtimeSettings({ specialistAgentToolRounds: 2 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => ({ facts: [] }),
  })) events.push(event)
  assert.ok(events.some((event) => event.type === 'trace'
    && event.entry.type === 'tool_result'
    && JSON.stringify(event.entry.result).includes('financial_specialist_turn_limit')))
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('真实 Pi 使用冻结 timeout、freshness、并发和 compaction policy', async () => {
  const logs: Array<Record<string, unknown>> = []
  const settings = runtimeSettings({
    modelRequestTimeoutMinutes: 1,
    modelConcurrency: 1,
    toolConcurrency: 1,
    reportFreshnessDays: 3,
    compactionReserveTokens: 12_345,
  })
  const model = createPiModel({
    fauxResponses: [fauxAssistantMessage(fauxText('很慢'.repeat(100)))],
    fauxTokensPerSecond: 1,
    runtimeMinuteMs: 5,
    now: () => new Date('2026-08-13T00:00:00.000Z'),
    log: (entry) => logs.push(entry),
  })
  const startedAt = performance.now()
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      executionId: 'frozen-policy', runtimeSettings: settings,
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  }, /model_request_timeout/)
  assert.ok(performance.now() - startedAt < 100)
  assert.ok(logs.some((entry) => entry.type === 'runtime_policy'
    && entry.modelConcurrency === 1
    && entry.toolConcurrency === 1
    && entry.freshnessCutoff === '2026-08-10T00:00:00.000Z'
    && entry.compactionReserveTokens === 12_345))
})

test('专项 Pi provider 超时保留统一冻结 policy 错误语义', async () => {
  const model = createPiModel({
    fauxResponses: [
      fauxAssistantMessage(fauxToolCall('analyze_financials', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('专项慢响应'.repeat(100))),
    ],
    fauxTokensPerSecond: 1,
    runtimeMinuteMs: 5,
  })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      executionId: 'specialist-timeout',
      runtimeSettings: runtimeSettings({ modelRequestTimeoutMinutes: 1 }),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts, financials: {} }),
    })) { /* consume */ }
  }, /model_request_timeout/)
})

test('真实 Pi 在完整工具 Turn 边界按冻结 reserve 压缩后续 provider 上下文', async () => {
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxText('早期推理 '.repeat(1_000))),
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'compaction-boundary',
    runtimeSettings: runtimeSettings({ compactionReserveTokens: 1_000_000 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)
  const compacted = events.find((event) => event.type === 'trace' && event.entry.type === 'compaction')
  assert.equal(compacted?.type, 'trace')
  if (compacted?.type === 'trace' && compacted.entry.type === 'compaction') {
    assert.ok(compacted.entry.summarizedCount > 0)
  }
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('真实 Pi 由宿主确定性标记超过冻结 freshness 的事实与报告', async () => {
  const oldFact = { ...facts[0]!, observedAt: '2026-08-01T00:00:00.000Z' }
  const model = createPiModel({
    fauxResponses: [
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', {
        ...validReport,
        supportingEvidence: [oldFact.id], contraryEvidence: [oldFact.id],
        keyJudgments: [{ judgment: '短期趋势偏强', evidence: [oldFact.id] }],
      }), { stopReason: 'toolUse' }),
    ],
    now: () => new Date('2026-08-13T00:00:00.000Z'),
  })
  const events = []
  for await (const event of model.analyze({
    executionId: 'freshness-host', runtimeSettings: runtimeSettings({ reportFreshnessDays: 3 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: [oldFact],
    fetchFinancialContext: async () => ({ facts: [oldFact] }),
  })) events.push(event)
  const policy = events.find((event) => event.type === 'trace'
    && event.entry.type === 'runtime_policy')
  assert.match(JSON.stringify(policy), /fact:nvda:price:2026-08-12/)
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') {
    assert.match(completed.report.title, /^⚠ 数据时效提醒/)
    assert.ok(completed.report.limitations.some((item) => item.includes('超过 3 天 freshness')))
  }
})

test('真实 Pi 用冻结 model concurrency 限制并行 provider 请求', async () => {
  let active = 0
  let maximumActive = 0
  const logs = (entry: Record<string, unknown>) => {
    if (entry.type === 'model_request_start') {
      active += 1
      maximumActive = Math.max(maximumActive, active)
    }
    if (entry.type === 'model_request_end') active -= 1
  }
  const model = createPiModel({
    fauxResponses: [
      fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    ],
    fauxTokensPerSecond: 100,
    log: logs,
  })
  const settings = runtimeSettings({ mainAgentToolRounds: 1, modelConcurrency: 1 })
  await Promise.all(['one', 'two'].map(async (executionId) => {
    await assert.rejects(async () => {
      for await (const _event of model.analyze({
        executionId, runtimeSettings: settings,
        symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
        fetchFinancialContext: async () => ({ facts }),
      })) { /* consume */ }
    }, /analysis_turn_limit/)
  }))
  assert.equal(maximumActive, 1)
})

test('真实 Pi 使用冻结 execution wall deadline', async () => {
  const wallModel = createPiModel({
    fauxResponses: [fauxAssistantMessage(fauxText('墙钟超时'.repeat(100)))],
    fauxTokensPerSecond: 1,
    runtimeMinuteMs: 5,
  })
  await assert.rejects(async () => {
    for await (const _event of wallModel.analyze({
      executionId: 'wall-timeout',
      runtimeSettings: runtimeSettings({
        researchActiveMinutes: 4, executionWallClockMinutes: 1,
        modelRequestTimeoutMinutes: 60,
      }),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  }, /execution_runtime_timeout/)
})

test('真实 Pi 用冻结 tool concurrency 限制跨 execution 外部工具请求', async () => {
  let active = 0
  let maximumActive = 0
  let firstEntered!: () => void
  const entered = new Promise<void>((resolve) => { firstEntered = resolve })
  let releaseFirst!: () => void
  const barrier = new Promise<void>((resolve) => { releaseFirst = resolve })
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const run = async (executionId: string, settings = runtimeSettings({ modelConcurrency: 2, toolConcurrency: 1 })) => {
    const events = []
    for await (const event of model.analyze({
      executionId, runtimeSettings: settings,
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (executionId === 'tool-one') {
          firstEntered()
          await barrier
        }
        active -= 1
        return { facts }
      },
    })) events.push(event)
    assert.ok(events.some((event) => event.type === 'completed'))
  }
  const first = run('tool-one', runtimeSettings({
    modelConcurrency: 2, toolConcurrency: 1, researchActiveMinutes: 60,
  }))
  await entered
  const second = run('tool-two', runtimeSettings({
    modelConcurrency: 2, toolConcurrency: 1, researchActiveMinutes: 20,
  }))
  await new Promise((resolve) => setTimeout(resolve, 250))
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(maximumActive, 1)
})
