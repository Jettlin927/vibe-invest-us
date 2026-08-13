import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModels, fauxAssistantMessage, fauxText, fauxToolCall, type Context,
} from '@earendil-works/pi-ai'
import { defaultRuntimeSettings } from '@vibe-invest/contracts'

import {
  createPiModel as createProductionPiModel,
  type AnalyzeInput, type ModelOptions, type ToolRuntime,
} from '../src/model.js'
import { createActiveBudget } from '../src/runtime-policy.js'
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

function createPiModel(options: ModelOptions = {}) {
  const model = createProductionPiModel(options)
  return {
    analyze(input: AnalyzeInput) {
      return model.analyze({ ...input, toolRuntime: input.toolRuntime ?? createTestToolRuntime() })
    },
  }
}

function createTestToolRuntime(): ToolRuntime {
  let version = 0
  return {
    async ensureProjection(input) {
      return { id: `${input.executionId}:test-projection:${++version}`, version }
    },
    async recordModelRequest() {},
    async beginModelRequest(input) {
      return { id: `${input.requestId}:test-projection`, version: ++version }
    },
    async beginToolBatch() {},
    async startToolCall() {},
    async completeToolBatch() {},
  }
}

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

function toolTurnOperations(
  events: Array<{ type: string; entry?: { type?: string; operationId?: string } }>,
  pattern: RegExp,
) {
  return events.flatMap((event) => event.type === 'trace'
    && (event.entry?.type === 'tool_call' || event.entry?.type === 'tool_result')
    && event.entry.operationId && pattern.test(event.entry.operationId)
    ? [event.entry.operationId]
    : [])
}

function providerCallId(runtimeId: string) {
  return runtimeId
    .replace(/:specialist-invocation:[^:]+:attempt:\d+:position:\d+$/, '')
    .replace(/:(?:main|specialist|fundamental)-attempt:\d+:position:\d+$/, '')
}

function legacyOperationId(operationId: string) {
  return operationId
    .replace(/:specialist-invocation:[^:]+:attempt:\d+:position:\d+(?=:(?:call|result)$)/, '')
    .replace(/:(?:main|specialist|fundamental)-attempt:\d+:position:\d+(?=:(?:call|result)$)/, '')
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

test('完整工具结果保留在审计事件而模型只收到 Registry 声明的受控投影', async () => {
  let providerToolResult = ''
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(
      fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }, { id: 'bounded-context' }),
      { stopReason: 'toolUse' },
    ),
    (context) => {
      providerToolResult = context.messages.flatMap((message) => (
        message.role === 'toolResult' ? message.content : []
      )).flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n')
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' },
      )
    },
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(), executionId: 'bounded-projection',
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({
      facts, gaps: [], privateDiagnostic: '只允许保留在 PostgreSQL 审计视图',
    }),
  })) events.push(event)

  assert.match(providerToolResult, /fact:nvda:price:2026-08-12/)
  assert.doesNotMatch(providerToolResult, /privateDiagnostic|只允许保留在 PostgreSQL 审计视图/)
  const retained = events.find((event) => event.type === 'trace'
    && event.entry.type === 'tool_result' && event.entry.name === 'fetch_financial_context')
  assert.match(JSON.stringify(retained), /privateDiagnostic|只允许保留在 PostgreSQL 审计视图/)
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
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', badReport), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', badReport), { stopReason: 'toolUse' }),
  ] })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      runtimeSettings: runtimeSettings({ mainAgentToolRounds: 5 }),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
      knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  }, /report_tool_required/)
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

test('Pi Model 收到取消后关闭 provider、释放预算与槽位且后续请求可运行', async () => {
  let now = 0
  const budget = createActiveBudget(10_000, () => now, () => new AbortController().signal)
  const models = createModels()
  const originalStream = models.stream.bind(models)
  let iteratorClosed = 0
  models.stream = ((...args: Parameters<typeof models.stream>) => {
    const stream = originalStream(...args)
    return {
      ...stream,
      [Symbol.asyncIterator]() {
        const iterator = stream[Symbol.asyncIterator]()
        return {
          next: iterator.next.bind(iterator),
          return() {
            iteratorClosed += 1
            return iterator.return ? iterator.return() : Promise.resolve({
              done: true as const, value: undefined,
            })
          },
        }
      },
    }
  }) as typeof models.stream
  const model = createPiModel({
    modelsFactory: () => models,
    fauxResponses: [fauxAssistantMessage(fauxText('很长的分析'.repeat(100)))],
    fauxTokensPerSecond: 1,
  })
  const controller = new AbortController()
  let acquired = 0
  let released = 0
  let occupied = false
  const acquireModelSlot = async () => {
    assert.equal(occupied, false)
    occupied = true
    acquired += 1
    return () => {
      assert.equal(occupied, true)
      occupied = false
      released += 1
    }
  }
  const startedAt = performance.now()
  const consume = async () => {
    for await (const _event of model.analyze({
      executionId: 'cancelled-request', runtimeSettings: runtimeSettings(), activeBudget: budget,
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }), signal: controller.signal, acquireModelSlot,
    })) { /* consume */ }
  }
  setTimeout(() => {
    now = 25
    controller.abort()
  }, 20)
  await consume()
  assert.ok(performance.now() - startedAt < 250)
  now = 80
  assert.equal(iteratorClosed, 1)
  assert.equal(acquired, 1)
  assert.equal(released, 1)
  assert.equal(budget.elapsedMs(), 25)

  const nextModel = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), {
      stopReason: 'toolUse',
    }),
  ] })
  for await (const _event of nextModel.analyze({
    executionId: 'request-after-cancel', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }), acquireModelSlot,
  })) { /* consume */ }
  assert.equal(acquired, 2)
  assert.equal(released, 2)
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

test('主 Agent policy abort 为同批全部工具按原顺序补齐 toolResult 后收口', async () => {
  let now = 0
  const budget = createActiveBudget(10, () => now, () => new AbortController().signal)
  const first = fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }, { id: 'main-first' })
  const second = fauxToolCall('fetch_financial_context', { symbol: 'NVDA' }, { id: 'main-second' })
  const observedPairs: string[][] = []
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([first, second], { stopReason: 'toolUse' }),
    (context) => {
      observedPairs.push(context.messages.map((message) => message.role === 'toolResult'
        ? `toolResult:${providerCallId(message.toolCallId)}` : message.role))
      return fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' })
    },
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'main-policy', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => { now = 11; return { facts } },
  })) events.push(event)
  assert.deepEqual(observedPairs, [['user', 'assistant', 'toolResult:main-first', 'toolResult:main-second']])
  assert.deepEqual(events.filter((event) => event.type === 'trace'
    && (event.entry.type === 'tool_call' || event.entry.type === 'tool_result'))
    .filter((event) => event.type === 'trace' && /main-(first|second)/.test(event.entry.operationId))
    .map((event) => event.type === 'trace' ? legacyOperationId(event.entry.operationId) : ''), [
      'execution:main-policy:tool:main-first:call',
      'execution:main-policy:tool:main-second:call',
      'execution:main-policy:tool:main-first:result',
      'execution:main-policy:tool:main-second:result',
    ])
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('主 Agent 收口阶段拒绝整批非 submit 工具并向下一轮提供完整 toolResult', async () => {
  const rejectedFirst = fauxToolCall('fetch_financial_context', {}, { id: 'closing-first' })
  const rejectedSecond = fauxToolCall('analyze_financials', {}, { id: 'closing-second' })
  const observedResults: string[][] = []
  let executed = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}, { id: 'consume-round' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([rejectedFirst, rejectedSecond], { stopReason: 'toolUse' }),
    (context) => {
      observedResults.push(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? providerCallId(message.toolCallId) : ''))
      return fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport, { id: 'closing-submit' }), { stopReason: 'toolUse' })
    },
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'closing-main', runtimeSettings: runtimeSettings({ mainAgentToolRounds: 1 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => { executed += 1; return { facts } },
  })) events.push(event)

  assert.equal(executed, 1)
  assert.deepEqual(observedResults, [['consume-round', 'closing-first', 'closing-second']])
  assert.deepEqual(toolTurnOperations(events, /closing-(first|second)/).map(legacyOperationId), [
    'execution:closing-main:tool:closing-first:call',
    'execution:closing-main:tool:closing-second:call',
    'execution:closing-main:tool:closing-first:result',
    'execution:closing-main:tool:closing-second:result',
  ])
  assert.ok(events.filter((event) => event.type === 'trace' && event.entry.type === 'tool_result'
    && /closing-(first|second)/.test(event.entry.operationId))
    .every((event) => event.type === 'trace' && event.entry.isError
      && event.entry.result.error === 'tool_not_available'))
  assert.ok(events.some((event) => event.type === 'completed'))
})

for (const [position, calls, expectedExecutions] of [
  ['首位', [
    fauxToolCall('submit_analysis_report', validReport, { id: 'submit-first' }),
    fauxToolCall('fetch_financial_context', {}, { id: 'after-first' }),
  ], 0],
  ['中间', [
    fauxToolCall('fetch_financial_context', {}, { id: 'before-middle' }),
    fauxToolCall('submit_analysis_report', validReport, { id: 'submit-middle' }),
    fauxToolCall('fetch_financial_context', {}, { id: 'after-middle' }),
  ], 1],
  ['末位', [
    fauxToolCall('fetch_financial_context', {}, { id: 'before-last' }),
    fauxToolCall('submit_analysis_report', validReport, { id: 'submit-last' }),
  ], 1],
] as const) {
  test(`submit 位于批次${position}时先封存全部结果且不执行其后工具`, async () => {
    let executions = 0
    const committedResults: Array<{ toolCallId: string }> = []
    const toolRuntime = createTestToolRuntime()
    toolRuntime.completeToolBatch = async (input) => { committedResults.push(...input.results) }
    const finalContexts: Context[] = []
    const model = createPiModel({ fauxResponses: [
      (context) => {
        finalContexts.push(context)
        return fauxAssistantMessage([...calls], { stopReason: 'toolUse' })
      },
    ] })
    const events = []
    for await (const event of model.analyze({
      executionId: `submit-${position}`, runtimeSettings: runtimeSettings(),
      toolRuntime,
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => { executions += 1; return { facts } },
    })) events.push(event)

    assert.equal(executions, expectedExecutions)
    const ids = calls.map(({ id }) => id)
    assert.deepEqual(committedResults.map(({ toolCallId }) => providerCallId(toolCallId)), ids)
    const completedIndex = events.findIndex(({ type }) => type === 'completed')
    const finalResultIndex = events.findLastIndex((event) => event.type === 'trace'
      && event.entry.type === 'tool_result')
    assert.ok(completedIndex > finalResultIndex)
    const afterSubmit = ids.slice(ids.findIndex((id) => id.startsWith('submit-')) + 1)
    assert.ok(events.filter((event) => event.type === 'trace' && event.entry.type === 'tool_result'
      && afterSubmit.some((id) => event.entry.operationId.includes(`:${id}:`)))
      .every((event) => event.type === 'trace' && event.entry.isError))
  })
}

for (const [position, calls] of [
  ['首位', [
    fauxToolCall('hidden_shell', { command: 'whoami' }, { id: 'unknown-first' }),
    fauxToolCall('fetch_financial_context', {}, { id: 'valid-after-unknown' }),
  ]],
  ['中间', [
    fauxToolCall('fetch_financial_context', {}, { id: 'valid-before-unknown' }),
    fauxToolCall('hidden_shell', {}, { id: 'unknown-middle' }),
    fauxToolCall('fetch_financial_context', {}, { id: 'valid-after-middle' }),
  ]],
  ['末位', [
    fauxToolCall('fetch_financial_context', {}, { id: 'valid-before-last' }),
    fauxToolCall('hidden_shell', {}, { id: 'unknown-last' }),
  ]],
] as const) {
  test(`主 Agent 未知工具位于批次${position}时归一化错误且其他合法工具继续`, async () => {
    let executions = 0
    const observedResults: Array<{ id: string; value: unknown; isError: boolean }> = []
    const model = createPiModel({ fauxResponses: [
      fauxAssistantMessage([...calls], { stopReason: 'toolUse' }),
      (context) => {
        observedResults.push(...context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? {
            id: providerCallId(message.toolCallId), value: JSON.parse(message.content[0]?.type === 'text'
              ? message.content[0].text : '{}'), isError: message.isError,
          } : { id: '', value: null, isError: false }))
        return fauxAssistantMessage(
          fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' },
        )
      },
    ] })
    const events = []
    for await (const event of model.analyze({
      executionId: `unknown-${position}`, runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => { executions += 1; return { facts } },
    })) events.push(event)

    assert.equal(executions, 1)
    assert.deepEqual(observedResults.map(({ id }) => id), calls.map(({ id }) => id))
    assert.equal(observedResults.filter(({ id, isError }) => id.startsWith('valid-') && !isError).length,
      calls.filter(({ name }) => name === 'fetch_financial_context').length)
    const hidden = observedResults.find(({ id }) => id.startsWith('unknown-'))
    assert.deepEqual(hidden, {
      id: calls.find(({ id }) => id.startsWith('unknown-'))?.id,
      value: { error: 'tool_not_available', facts: [] }, isError: true,
    })
    assert.doesNotMatch(JSON.stringify(observedResults.map(({ value }) => value)),
      /Tool .* not found|hidden_shell|Validation failed/)
    assert.deepEqual(toolTurnOperations(events, /:tool:(unknown-|valid-)/).map(legacyOperationId), [
      ...calls.map(({ id }) => `execution:unknown-${position}:tool:${id}:call`),
      ...calls.map(({ id }) => `execution:unknown-${position}:tool:${id}:result`),
    ])
    assert.ok(events.some(({ type }) => type === 'completed'))
  })
}

test('主 Agent 非法参数只拒绝当前 call 且同批合法工具仍执行', async () => {
  const invalid = fauxToolCall('fetch_financial_context', { symbol: '' }, { id: 'invalid-arguments' })
  const valid = fauxToolCall('fetch_financial_context', {}, { id: 'valid-with-invalid' })
  let executions = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([invalid, valid], { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'invalid-main', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => { executions += 1; return { facts } },
  })) events.push(event)
  assert.equal(executions, 1)
  const invalidResult = events.find((event) => event.type === 'trace'
    && legacyOperationId(event.entry.operationId) === 'execution:invalid-main:tool:invalid-arguments:result')
  assert.deepEqual(invalidResult && { ...invalidResult, entry: {
    ...invalidResult.entry, startedAt: typeof invalidResult.entry.startedAt,
    completedAt: typeof invalidResult.entry.completedAt,
  } }, { type: 'trace', entry: {
    type: 'tool_result', name: 'fetch_financial_context',
    toolCallId: 'invalid-arguments:main-attempt:1:position:1',
    result: { error: 'invalid_tool_arguments', facts: [] }, isError: true,
    startedAt: 'string', completedAt: 'string', completionOrder: 1,
    operationId: 'execution:invalid-main:tool:invalid-arguments:main-attempt:1:position:1:result',
  } })
  assert.doesNotMatch(JSON.stringify(events), /Validation failed|Received arguments/)
})

test('同批重复 provider call id 会稳定派生唯一 Context 与 trace 配对', async () => {
  const contextPairs: string[][] = []
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([
      fauxToolCall('fetch_financial_context', {}, { id: 'duplicate-call' }),
      fauxToolCall('fetch_financial_context', {}, { id: 'duplicate-call' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      const assistant = context.messages.find(({ role }) => role === 'assistant')
      contextPairs.push([
        ...(assistant?.role === 'assistant'
          ? assistant.content.filter(({ type }) => type === 'toolCall').map(({ id }) => id)
          : []),
        ...context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''),
      ])
      return fauxAssistantMessage(
        fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' },
      )
    },
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'duplicate-provider-id', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)

  assert.deepEqual(contextPairs, [[
    'duplicate-call:main-attempt:1:position:1', 'duplicate-call:main-attempt:1:position:2',
    'duplicate-call:main-attempt:1:position:1', 'duplicate-call:main-attempt:1:position:2',
  ]])
  assert.deepEqual(toolTurnOperations(events, /:tool:duplicate-call/), [
    'execution:duplicate-provider-id:tool:duplicate-call:main-attempt:1:position:1:call',
    'execution:duplicate-provider-id:tool:duplicate-call:main-attempt:1:position:2:call',
    'execution:duplicate-provider-id:tool:duplicate-call:main-attempt:1:position:1:result',
    'execution:duplicate-provider-id:tool:duplicate-call:main-attempt:1:position:2:result',
  ])
})

for (const providerId of ['reused-across-turns', ''] as const) {
  test(`主 Agent 跨 Turn ${providerId ? '复用' : '空'} provider call id 仍保持唯一配对`, async () => {
    const observedIds: string[][] = []
    const model = createPiModel({ fauxResponses: [
      fauxAssistantMessage(
        fauxToolCall('fetch_financial_context', {}, { id: providerId }), { stopReason: 'toolUse' },
      ),
      (context) => {
        observedIds.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(
          fauxToolCall('fetch_financial_context', {}, { id: providerId }), { stopReason: 'toolUse' },
        )
      },
      (context) => {
        observedIds.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(
          fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' },
        )
      },
    ] })
    const events = []
    for await (const event of model.analyze({
      executionId: `main-cross-turn-${providerId || 'empty'}`, runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }),
    })) events.push(event)

    assert.equal(observedIds[0]?.length, 1)
    assert.equal(observedIds[1]?.length, 2)
    assert.notEqual(observedIds[1]?.[0], observedIds[1]?.[1])
    const operations = toolTurnOperations(events, /:tool:/)
    assert.equal(new Set(operations).size, operations.length)
  })
}

for (const providerId of ['specialist-reused-across-turns', ''] as const) {
  test(`专项 Agent 跨 Turn ${providerId ? '复用' : '空'} provider call id 仍保持唯一配对`, async () => {
    const observedIds: string[][] = []
    const model = createPiModel({ fauxResponses: [
      fauxAssistantMessage(
        fauxToolCall('analyze_financials', {}, { id: `entry-${providerId || 'empty'}` }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('search_news_by_keyword', {}, { id: providerId }), { stopReason: 'toolUse' },
      ),
      (context) => {
        observedIds.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(
          fauxToolCall('search_news_by_keyword', {}, { id: providerId }), { stopReason: 'toolUse' },
        )
      },
      (context) => {
        observedIds.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(fauxText('专项完成'))
      },
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    ] })
    const events = []
    for await (const event of model.analyze({
      executionId: `specialist-cross-turn-${providerId || 'empty'}`,
      runtimeSettings: runtimeSettings(), symbol: 'NVDA', systemPrompt: 'system',
      userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts, financials: {} }),
      searchNews: async () => ({ facts: [] }),
    })) events.push(event)

    assert.equal(observedIds[0]?.length, 1)
    assert.equal(observedIds[1]?.length, 2)
    assert.notEqual(observedIds[1]?.[0], observedIds[1]?.[1])
    const operations = toolTurnOperations(events, /specialist-tool:/)
    assert.equal(new Set(operations).size, operations.length)
  })
}

for (const providerId of ['specialist-reused-across-invocations', ''] as const) {
  test(`同一 execution 两次专项 invocation 的${providerId ? '重复' : '空'} call id 各自唯一配对`, async () => {
    const specialistContexts: string[][] = []
    const mainContexts: string[][] = []
    const model = createPiModel({ fauxResponses: [
      fauxAssistantMessage(
        fauxToolCall('analyze_financials', {}, { id: 'reused-specialist-parent' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('search_news_by_keyword', {}, { id: providerId }), { stopReason: 'toolUse' },
      ),
      (context) => {
        specialistContexts.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(fauxText('第一次专项完成'))
      },
      (context) => {
        mainContexts.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(
          fauxToolCall('analyze_financials', {}, { id: 'reused-specialist-parent' }),
          { stopReason: 'toolUse' },
        )
      },
      fauxAssistantMessage(
        fauxToolCall('search_news_by_keyword', {}, { id: providerId }), { stopReason: 'toolUse' },
      ),
      (context) => {
        specialistContexts.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(fauxText('第二次专项完成'))
      },
      (context) => {
        mainContexts.push(context.messages.filter(({ role }) => role === 'toolResult')
          .map((message) => message.role === 'toolResult' ? message.toolCallId : ''))
        return fauxAssistantMessage(
          fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' },
        )
      },
    ] })
    const events = []
    for await (const event of model.analyze({
      executionId: `specialist-invocations-${providerId || 'empty'}`,
      runtimeSettings: runtimeSettings(), symbol: 'NVDA', systemPrompt: 'system',
      userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts, financials: {} }),
      searchNews: async () => ({ facts: [] }),
    })) events.push(event)

    assert.equal(specialistContexts.length, 2)
    assert.equal(specialistContexts[0]?.length, 1)
    assert.equal(specialistContexts[1]?.length, 1)
    assert.notEqual(specialistContexts[0]?.[0], specialistContexts[1]?.[0])
    assert.deepEqual(mainContexts.map((ids) => ids.length), [1, 2])
    assert.notEqual(mainContexts[1]?.[0], mainContexts[1]?.[1])
    const operations = toolTurnOperations(events, /specialist-tool:/)
    assert.equal(operations.length, 4)
    assert.equal(new Set(operations).size, operations.length)
  })
}

test('专项 Agent policy abort 为同批全部工具按原顺序补齐 toolResult 后再返回主 Agent', async () => {
  let now = 0
  const budget = createActiveBudget(10, () => now, () => new AbortController().signal)
  const specialistPairs: string[][] = []
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'specialist' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', { keyword: 'NVDA' }, { id: 'specialist-first' }),
      fauxToolCall('get_technical_indicators', { symbol: 'NVDA' }, { id: 'specialist-second' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      specialistPairs.push(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? providerCallId(message.toolCallId) : ''))
      return fauxAssistantMessage(fauxText('专项收口'))
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'specialist-policy', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: { quarters: [] } }),
    searchNews: async () => { now = 11; return { facts: [] } },
    fetchTechnicalIndicators: async () => ({ facts: [] }),
  })) events.push(event)
  assert.deepEqual(specialistPairs, [['specialist-first', 'specialist-second']])
  assert.deepEqual(events.filter((event) => event.type === 'trace'
    && (event.entry.type === 'tool_call' || event.entry.type === 'tool_result')
    && event.entry.operationId.includes('specialist-tool'))
    .map((event) => event.type === 'trace' ? legacyOperationId(event.entry.operationId) : ''), [
      'execution:specialist-policy:specialist-tool:specialist-first:call',
      'execution:specialist-policy:specialist-tool:specialist-second:call',
      'execution:specialist-policy:specialist-tool:specialist-first:result',
      'execution:specialist-policy:specialist-tool:specialist-second:result',
    ])
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('专项 Agent 轮次到限后拒绝整批工具并向收口轮提供完整 toolResult', async () => {
  const observedResults: string[][] = []
  let searches = 0
  let indicators = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'specialist-entry' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}, { id: 'specialist-consume' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', {}, { id: 'specialist-closing-first' }),
      fauxToolCall('get_technical_indicators', {}, { id: 'specialist-closing-second' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      observedResults.push(context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? providerCallId(message.toolCallId) : ''))
      return fauxAssistantMessage(fauxText('专项完成收口'))
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'specialist-closing',
    runtimeSettings: runtimeSettings({ specialistAgentToolRounds: 1 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => { searches += 1; return { facts: [] } },
    fetchTechnicalIndicators: async () => { indicators += 1; return { facts: [] } },
  })) events.push(event)

  assert.equal(searches, 1)
  assert.equal(indicators, 0)
  assert.deepEqual(observedResults, [[
    'specialist-consume', 'specialist-closing-first', 'specialist-closing-second',
  ]])
  assert.deepEqual(toolTurnOperations(events, /specialist-closing-(first|second)/).map(legacyOperationId), [
    'execution:specialist-closing:specialist-tool:specialist-closing-first:call',
    'execution:specialist-closing:specialist-tool:specialist-closing-second:call',
    'execution:specialist-closing:specialist-tool:specialist-closing-first:result',
    'execution:specialist-closing:specialist-tool:specialist-closing-second:result',
  ])
  assert.ok(events.filter((event) => event.type === 'trace' && event.entry.type === 'tool_result'
    && /specialist-closing-(first|second)/.test(event.entry.operationId))
    .every((event) => event.type === 'trace' && event.entry.isError
      && event.entry.result.error === 'tool_not_available'))
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('专项未知工具与非法参数逐项归一化且同批合法工具继续执行', async () => {
  const specialistResults: Array<{ id: string; value: unknown; isError: boolean }> = []
  let searches = 0
  let indicators = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'validation-entry' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('hidden_specialist_tool', {}, { id: 'specialist-unknown' }),
      fauxToolCall('search_news_by_keyword', { keyword: '' }, { id: 'specialist-invalid' }),
      fauxToolCall('search_news_by_keyword', { keyword: 'NVDA' }, { id: 'specialist-valid-news' }),
      fauxToolCall('get_technical_indicators', {}, { id: 'specialist-valid-indicator' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      specialistResults.push(...context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? {
          id: providerCallId(message.toolCallId), value: JSON.parse(message.content[0]?.type === 'text'
            ? message.content[0].text : '{}'), isError: message.isError,
        } : { id: '', value: null, isError: false }))
      return fauxAssistantMessage(fauxText('专项校验完成'))
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'specialist-validation', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => { searches += 1; return { facts: [] } },
    fetchTechnicalIndicators: async () => { indicators += 1; return { facts: [] } },
  })) events.push(event)

  assert.equal(searches, 1)
  assert.equal(indicators, 1)
  assert.deepEqual(specialistResults.map(({ id }) => id), [
    'specialist-unknown', 'specialist-invalid',
    'specialist-valid-news', 'specialist-valid-indicator',
  ])
  assert.deepEqual(specialistResults.slice(0, 2), [
    { id: 'specialist-unknown', value: { error: 'tool_not_available', facts: [] }, isError: true },
    { id: 'specialist-invalid', value: { error: 'invalid_tool_arguments', facts: [] }, isError: true },
  ])
  assert.deepEqual(toolTurnOperations(events, /specialist-tool:specialist-(unknown|invalid|valid)/)
    .map(legacyOperationId), [
    'execution:specialist-validation:specialist-tool:specialist-unknown:call',
    'execution:specialist-validation:specialist-tool:specialist-invalid:call',
    'execution:specialist-validation:specialist-tool:specialist-valid-news:call',
    'execution:specialist-validation:specialist-tool:specialist-valid-indicator:call',
    'execution:specialist-validation:specialist-tool:specialist-unknown:result',
    'execution:specialist-validation:specialist-tool:specialist-invalid:result',
    'execution:specialist-validation:specialist-tool:specialist-valid-news:result',
    'execution:specialist-validation:specialist-tool:specialist-valid-indicator:result',
  ])
})

test('专项未投影工具统一不可用且同批已投影工具继续执行', async () => {
  const specialistResults: Array<{ id: string; value: unknown; isError: boolean }> = []
  let searches = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(
      fauxToolCall('analyze_financials', {}, { id: 'projection-entry' }), { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([
      fauxToolCall('get_technical_indicators', {}, { id: 'not-projected' }),
      fauxToolCall('search_news_by_keyword', {}, { id: 'projected-news' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      specialistResults.push(...context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? {
          id: providerCallId(message.toolCallId), value: JSON.parse(message.content[0]?.type === 'text'
            ? message.content[0].text : '{}'), isError: message.isError,
        } : { id: '', value: null, isError: false }))
      return fauxAssistantMessage(fauxText('专项投影检查完成'))
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'specialist-projection', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => { searches += 1; return { facts: [] } },
  })) events.push(event)

  assert.equal(searches, 1)
  assert.deepEqual(specialistResults, [
    { id: 'not-projected', value: { error: 'tool_not_available', facts: [] }, isError: true },
    { id: 'projected-news', value: { facts: [] }, isError: false },
  ])
  assert.doesNotMatch(JSON.stringify(events), /technical_indicators_unavailable/)
})

test('主 Agent 原子提交结果发布前已停止 runtime active segment', async () => {
  let now = 0
  const budget = createActiveBudget(100, () => now, () => new AbortController().signal)
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('hidden_tool', {}, { id: 'active-release' }), { stopReason: 'toolUse' }),
  ] })
  const iterator = model.analyze({
    executionId: 'validation-active-release', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
  })
  while (true) {
    const step = await iterator.next()
    assert.equal(step.done, false)
    if (!step.done && step.value.type === 'trace'
      && legacyOperationId(step.value.entry.operationId)
        === 'execution:validation-active-release:tool:active-release:result') break
  }
  now = 40
  await iterator.return(undefined)
  now = 90
  assert.equal(budget.elapsedMs(), 0)
})

test('主 Agent 原子提交后下游消费失败不会重新开启 runtime active segment', async () => {
  let now = 0
  const budget = createActiveBudget(100, () => now, () => new AbortController().signal)
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('hidden_tool', {}, { id: 'trace-write-failure' }), {
      stopReason: 'toolUse',
    }),
  ] })
  const iterator = model.analyze({
    executionId: 'validation-trace-write-failure', runtimeSettings: runtimeSettings(),
    activeBudget: budget, symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
    knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
  })
  while (true) {
    const step = await iterator.next()
    assert.equal(step.done, false)
    if (!step.done && step.value.type === 'trace'
      && legacyOperationId(step.value.entry.operationId).endsWith(':trace-write-failure:result')) break
  }
  now = 35
  await assert.rejects(iterator.throw(new Error('pg_trace_failed')), /pg_trace_failed/)
  now = 90
  assert.equal(budget.elapsedMs(), 0)
})

test('主工具 active start 失败会释放槽位且同批后续工具可再次取得', async () => {
  const baseBudget = createActiveBudget(60_000)
  let starts = 0
  const budget = {
    ...baseBudget,
    start(signal: AbortSignal) {
      starts += 1
      if (starts === 3) throw new Error('tool_active_start_failed')
      return baseBudget.start(signal)
    },
  }
  let acquired = 0
  let released = 0
  let fetches = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage([
      fauxToolCall('fetch_financial_context', {}, { id: 'active-failure' }),
      fauxToolCall('fetch_financial_context', {}, { id: 'active-retry' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'main-tool-active-start', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => { fetches += 1; return { facts } },
    acquireToolSlot: async () => {
      acquired += 1
      return () => { released += 1 }
    },
  })) events.push(event)

  assert.equal(fetches, 1)
  assert.equal(acquired, 2)
  assert.equal(released, 2)
  assert.match(JSON.stringify(events), /tool_active_start_failed/)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('专项工具 start log 失败会释放槽位且同批后续工具可再次取得', async () => {
  let acquired = 0
  let released = 0
  let starts = 0
  let fetches = 0
  const model = createPiModel({
    fauxResponses: [
      fauxAssistantMessage(fauxToolCall('analyze_financials', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('search_news_by_keyword', {}, { id: 'log-failure' }),
        fauxToolCall('search_news_by_keyword', {}, { id: 'log-retry' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('专项完成')),
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    ],
    log(entry) {
      if (entry.type === 'tool_request_start' && ++starts === 1) throw new Error('tool_start_log_failed')
    },
  })
  const events = []
  for await (const event of model.analyze({
    executionId: 'main-tool-start-log', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => { fetches += 1; return { facts: [] } },
    acquireToolSlot: async () => {
      acquired += 1
      return () => { released += 1 }
    },
  })) events.push(event)

  assert.equal(fetches, 1)
  assert.equal(acquired, 3)
  assert.equal(released, 3)
  assert.match(JSON.stringify(events), /tool_start_log_failed/)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('专项工具 end log 失败不覆盖结果且后续 Turn 可再次取得槽位', async () => {
  let acquired = 0
  let released = 0
  let searches = 0
  const model = createPiModel({
    fauxResponses: [
      fauxAssistantMessage(fauxToolCall('analyze_financials', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}, { id: 'logged-first' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}, { id: 'logged-second' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('专项完成')),
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    ],
    log(entry) {
      if (entry.type === 'tool_request_end') throw new Error('tool_end_log_failed')
    },
  })
  const events = []
  for await (const event of model.analyze({
    executionId: 'specialist-end-log', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => { searches += 1; return { facts: [] } },
    acquireToolSlot: async () => {
      acquired += 1
      return () => { released += 1 }
    },
  })) events.push(event)

  assert.equal(searches, 2)
  assert.equal(acquired, 3)
  assert.equal(released, 3)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('专项 Agent 在工具并发槽等待期 abort 仍为同批全部调用补齐 toolResult', async () => {
  const controller = new AbortController()
  let acquireCount = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'waiting-specialist' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', {}, { id: 'waiting-first' }),
      fauxToolCall('get_technical_indicators', {}, { id: 'waiting-second' }),
    ], { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    runtimeSettings: runtimeSettings(), signal: controller.signal, executionId: 'gate-wait',
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: { quarters: [] } }),
    acquireToolSlot: async (signal) => {
      acquireCount += 1
      if (acquireCount === 1) return () => {}
      controller.abort(new Error('cancelled'))
      signal.throwIfAborted()
      return () => {}
    },
    searchNews: async () => ({ facts: [] }),
  })) {
    events.push(event)
  }
  const specialistAudit = events.filter((event) => event.type === 'trace'
    && (event.entry.type === 'tool_call' || event.entry.type === 'tool_result')
    && event.entry.operationId.includes('specialist-tool'))
    .map((event) => event.type === 'trace' ? legacyOperationId(event.entry.operationId) : '')
  assert.deepEqual(new Set(specialistAudit.slice(0, 2)), new Set([
    'execution:gate-wait:specialist-tool:waiting-first:call',
    'execution:gate-wait:specialist-tool:waiting-second:call',
  ]))
  assert.deepEqual(new Set(specialistAudit.slice(2)), new Set([
    'execution:gate-wait:specialist-tool:waiting-first:result',
    'execution:gate-wait:specialist-tool:waiting-second:result',
  ]))
  assert.ok(events.some((event) => event.type === 'cancelled'))
})

test('专项 abort result 的消费者提前关闭时仍释放已取得的工具槽', async () => {
  const controller = new AbortController()
  let acquired = 0
  let released = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'release-entry' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('search_news_by_keyword', {}, { id: 'release-tool' }), { stopReason: 'toolUse' }),
  ] })
  const iterator = model.analyze({
    executionId: 'specialist-release', runtimeSettings: runtimeSettings(), signal: controller.signal,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    acquireToolSlot: async () => {
      acquired += 1
      return () => { released += 1 }
    },
    searchNews: async () => {
      controller.abort(new Error('cancelled'))
      throw controller.signal.reason
    },
  })
  while (true) {
    const step = await iterator.next()
    assert.equal(step.done, false)
    if (!step.done && step.value.type === 'trace'
      && step.value.entry.type === 'tool_result'
      && step.value.entry.operationId.includes('specialist-tool:release-tool')) break
  }

  assert.equal(acquired, 2)
  assert.equal(released, 2)
  await iterator.return(undefined)
  assert.equal(released, 2)
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
  ] })
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
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') {
    assert.equal(completed.report.title, validReport.title)
    assert.deepEqual(completed.report.limitations, [])
  }
})

test('专项同批工具实际并行完成但下一轮仍按原 call 顺序接收结果', async () => {
  let releaseSlow!: () => void
  const slowBarrier = new Promise<void>((resolve) => { releaseSlow = resolve })
  const completionOrder: string[] = []
  let nextTurnResultOrder: string[] = []
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('analyze_financials', {}, { id: 'parallel-entry' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall('search_news_by_keyword', {}, { id: 'parallel-slow' }),
      fauxToolCall('get_technical_indicators', {}, { id: 'parallel-fast' }),
    ], { stopReason: 'toolUse' }),
    (context) => {
      nextTurnResultOrder = context.messages.filter(({ role }) => role === 'toolResult')
        .map((message) => message.role === 'toolResult' ? providerCallId(message.toolCallId) : '')
        .filter((id) => id.startsWith('parallel-'))
      return fauxAssistantMessage(fauxText('专项完成'))
    },
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  for await (const _event of model.analyze({
    executionId: 'parallel-specialist', runtimeSettings: runtimeSettings(),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts, financials: {} }),
    searchNews: async () => {
      await slowBarrier
      completionOrder.push('slow')
      return { facts: [] }
    },
    fetchTechnicalIndicators: async () => {
      completionOrder.push('fast')
      releaseSlow()
      return { facts: [] }
    },
  })) {}
  assert.deepEqual(completionOrder, ['fast', 'slow'])
  assert.deepEqual(nextTurnResultOrder, ['parallel-slow', 'parallel-fast'])
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
    fauxAssistantMessage(fauxText('专项 Agent 已停止新增研究并整理现有证据。')),
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
    && JSON.stringify(event.entry.result).includes('停止新增研究')))
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('主 Agent 工具轮次到限后停止研究并在两轮内确定性收口报告', async () => {
  let toolCalls = 0
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxText('收口前整理')),
    fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
  ] })
  const events = []
  for await (const event of model.analyze({
    executionId: 'main-closing', runtimeSettings: runtimeSettings({ mainAgentToolRounds: 1 }),
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => { toolCalls += 1; return { facts } },
  })) events.push(event)
  assert.equal(toolCalls, 1)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('研究 active 在 provider 后耗尽时不再调用研究工具并由主 Agent 收口为报告', async () => {
  let toolCalls = 0
  let now = 0
  const budget = createActiveBudget(10, () => now, () => new AbortController().signal)
  const model = createPiModel({
    fauxResponses: [
      () => {
        now = 11
        return fauxAssistantMessage(
          fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' },
        )
      },
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    ],
  })
  const events = []
  for await (const event of model.analyze({
    executionId: 'active-closing', runtimeSettings: runtimeSettings({ researchActiveMinutes: 1, modelRequestTimeoutMinutes: 60 }),
    activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => {
      toolCalls += 1
      return { facts }
    },
  })) events.push(event)
  assert.equal(toolCalls, 0)
  assert.ok(events.some((event) => event.type === 'completed'))
})

test('真实 Pi 使用冻结 timeout、并发且只审计 freshness/compaction 设置', async () => {
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
    && entry.compactionReserveTokens === 12_345))
})

for (const failure of ['stream', 'iterator', 'next'] as const) {
  test(`主模型 ${failure} 同步异常会释放 model slot 且后续请求可运行`, async () => {
    const models = createModels()
    const originalStream = models.stream.bind(models)
    let fail = true
    let iteratorClosed = 0
    models.stream = ((...args: Parameters<typeof models.stream>) => {
      if (!fail) return originalStream(...args)
      fail = false
      if (failure === 'stream') throw new Error('stream_construction_failed')
      const stream = originalStream(...args)
      if (failure === 'next') {
        return {
          ...stream,
          [Symbol.asyncIterator]() {
            return {
              next: async () => { throw new Error('next_construction_failed') },
              return: async () => {
                iteratorClosed += 1
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      }
      return {
        ...stream,
        [Symbol.asyncIterator]() { throw new Error('iterator_construction_failed') },
      }
    }) as typeof models.stream
    const model = createPiModel({
      modelsFactory: () => models,
      fauxResponses: [
        fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
      ],
    })
    let acquired = 0
    let released = 0
    let recorded = 0
    const toolRuntime = createTestToolRuntime()
    toolRuntime.recordModelRequest = async () => { recorded += 1 }
    const run = async (executionId: string) => {
      for await (const _event of model.analyze({
        executionId, runtimeSettings: runtimeSettings(), symbol: 'NVDA',
        systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
        fetchFinancialContext: async () => ({ facts }),
        acquireModelSlot: async () => {
          acquired += 1
          return () => { released += 1 }
        },
        toolRuntime,
      })) { /* consume */ }
    }
    await assert.rejects(run(`${failure}-first`), new RegExp(`${failure}_construction_failed`))
    assert.equal(recorded, 1)
    await run(`${failure}-second`)
    assert.equal(acquired, 2)
    assert.equal(released, 2)
    if (failure === 'next') assert.equal(iteratorClosed, 1)
  })
}

for (const failure of ['active', 'log'] as const) {
  test(`模型请求 ${failure} start 同步异常会回滚 model slot 且后续请求可运行`, async () => {
    let fail = true
    const baseBudget = createActiveBudget(60_000)
    const budget = {
      ...baseBudget,
      start(signal: AbortSignal) {
        if (failure === 'active' && fail) {
          fail = false
          throw new Error('active_start_failed')
        }
        return baseBudget.start(signal)
      },
    }
    const model = createPiModel({
      fauxResponses: [
        fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
      ],
      log(entry) {
        if (failure === 'log' && fail && entry.type === 'model_request_start') {
          fail = false
          throw new Error('log_start_failed')
        }
      },
    })
    let acquired = 0
    let released = 0
    let recorded = 0
    const toolRuntime = createTestToolRuntime()
    toolRuntime.recordModelRequest = async () => { recorded += 1 }
    const run = async (executionId: string) => {
      for await (const _event of model.analyze({
        executionId, runtimeSettings: runtimeSettings(), activeBudget: budget,
        symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
        fetchFinancialContext: async () => ({ facts }),
        acquireModelSlot: async () => {
          acquired += 1
          return () => { released += 1 }
        },
        toolRuntime,
      })) { /* consume */ }
    }
    await assert.rejects(run(`${failure}-first`), new RegExp(`${failure}_start_failed`))
    assert.equal(recorded, 0)
    await run(`${failure}-second`)
    assert.equal(acquired, 2)
    assert.equal(released, 2)
  })
}

test('模型槽等待取消不记录 phantom request 且不调用 provider', async () => {
  const controller = new AbortController()
  let providerCalls = 0
  let recorded = 0
  const models = createModels()
  models.stream = (() => {
    providerCalls += 1
    throw new Error('provider_must_not_run')
  }) as typeof models.stream
  const toolRuntime = createTestToolRuntime()
  toolRuntime.recordModelRequest = async () => { recorded += 1 }
  const model = createPiModel({
    modelsFactory: () => models,
    fauxResponses: [fauxAssistantMessage(fauxText('不应运行'))],
  })
  const consume = async () => {
    for await (const _event of model.analyze({
      executionId: 'slot-wait-cancelled', runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }), toolRuntime,
      signal: controller.signal,
      acquireModelSlot: (signal) => new Promise<() => void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })) { /* consume */ }
  }
  const running = consume()
  setTimeout(() => controller.abort(), 10)
  await running
  assert.equal(recorded, 0)
  assert.equal(providerCalls, 0)
})

test('模型 request 审计失败时 provider 不运行且精确释放 owner', async () => {
  let providerCalls = 0
  let released = 0
  const models = createModels()
  models.stream = (() => {
    providerCalls += 1
    throw new Error('provider_must_not_run')
  }) as typeof models.stream
  const toolRuntime = createTestToolRuntime()
  toolRuntime.recordModelRequest = async () => { throw new Error('request_audit_failed') }
  const model = createPiModel({
    modelsFactory: () => models,
    fauxResponses: [fauxAssistantMessage(fauxText('不应运行'))],
  })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      executionId: 'request-audit-failed', runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }), toolRuntime,
      acquireModelSlot: async () => () => { released += 1 },
    })) { /* consume */ }
  }, /request_audit_failed/)
  assert.equal(providerCalls, 0)
  assert.equal(released, 1)
})

test('工具 start 审计失败时 fail closed 且不执行 handler 或完成批次', async () => {
  let handlerCalls = 0
  let completedBatches = 0
  const toolRuntime = createTestToolRuntime()
  toolRuntime.startToolCall = async () => { throw new Error('tool_start_audit_failed') }
  toolRuntime.completeToolBatch = async () => { completedBatches += 1 }
  const model = createPiModel({ fauxResponses: [
    fauxAssistantMessage(fauxToolCall('fetch_financial_context', {}), { stopReason: 'toolUse' }),
  ] })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      executionId: 'tool-start-audit-failed', runtimeSettings: runtimeSettings(),
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => { handlerCalls += 1; return { facts } }, toolRuntime,
    })) { /* consume */ }
  }, /tool_start_audit_failed/)
  assert.equal(handlerCalls, 0)
  assert.equal(completedBatches, 0)
})

test('主模型消费者提前 return 会精确释放 model slot 与 active budget', async () => {
  let now = 0
  const budget = createActiveBudget(100, () => now, () => new AbortController().signal)
  let acquired = 0
  let released = 0
  const models = createModels()
  const originalStream = models.stream.bind(models)
  let iteratorClosed = 0
  models.stream = ((...args: Parameters<typeof models.stream>) => {
    const stream = originalStream(...args)
    return {
      ...stream,
      [Symbol.asyncIterator]() {
        const iterator = stream[Symbol.asyncIterator]()
        return {
          next: iterator.next.bind(iterator),
          async return() {
            iteratorClosed += 1
            return iterator.return ? iterator.return() : { done: true as const, value: undefined }
          },
        }
      },
    }
  }) as typeof models.stream
  const model = createPiModel({ modelsFactory: () => models, fauxResponses: [
    fauxAssistantMessage(fauxText('流式内容')),
  ] })
  const iterator = model.analyze({
    executionId: 'model-consumer-return', runtimeSettings: runtimeSettings(), activeBudget: budget,
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
    fetchFinancialContext: async () => ({ facts }),
    acquireModelSlot: async () => {
      acquired += 1
      return () => { released += 1 }
    },
  })
  while (true) {
    const step = await iterator.next()
    assert.equal(step.done, false)
    if (!step.done && step.value.type === 'trace' && step.value.entry.type === 'model_event') break
  }
  now = 25
  await iterator.return(undefined)
  now = 80
  assert.equal(acquired, 1)
  assert.equal(released, 1)
  assert.equal(iteratorClosed, 1)
  assert.equal(budget.elapsedMs(), 25)
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

test('compaction/freshness 仅进入审计 seam 且不注入普通模型文本或改写报告', async () => {
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
  const policy = events.find((event) => event.type === 'trace'
    && event.entry.type === 'runtime_policy')
  assert.match(JSON.stringify(policy), /"reportFreshnessDays":7/)
  assert.match(JSON.stringify(policy), /"compactionReserveTokens":1000000/)
  const prompt = events.find((event) => event.type === 'trace' && event.entry.type === 'system_prompt')
  assert.deepEqual(prompt, {
    type: 'trace', entry: {
      type: 'system_prompt', content: 'system',
      operationId: 'execution:compaction-boundary:system-prompt',
    },
  })
  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') {
    assert.deepEqual(completed.report, validReport)
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
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('submit_analysis_report', validReport), { stopReason: 'toolUse' }),
    ],
    fauxTokensPerSecond: 100,
    log: logs,
  })
  const settings = runtimeSettings({ mainAgentToolRounds: 1, modelConcurrency: 1 })
  await Promise.all(['one', 'two'].map(async (executionId) => {
    for await (const _event of model.analyze({
        executionId, runtimeSettings: settings,
        symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
        fetchFinancialContext: async () => ({ facts }),
      })) { /* consume */ }
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
