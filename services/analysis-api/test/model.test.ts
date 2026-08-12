import assert from 'node:assert/strict'
import test from 'node:test'

import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'

import { createPiModel } from '../src/model.js'

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
    symbol: 'NVDA', systemPrompt: '只引用给定事实。', userPrompt: '分析 NVDA。',
    knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
  })) events.push(event)

  const completed = events.find((event) => event.type === 'completed')
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') assert.deepEqual(completed.report, validReport)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_call'))
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
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
      knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  }, /analysis_turn_limit/)
})

test('Pi Model 拒绝结构不完整的报告', async () => {
  const malformed = { ...validReport } as Record<string, unknown>
  delete malformed.scenarios
  const model = createPiModel({ fauxResponses: successResponses(malformed as typeof validReport) })
  await assert.rejects(async () => {
    for await (const _event of model.analyze({
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user',
      knownFacts: facts, fetchFinancialContext: async () => ({ facts }),
    })) { /* consume */ }
  })
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
      symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: facts,
      fetchFinancialContext: async () => ({ facts }), signal: controller.signal,
    })) { /* consume */ }
  }
  setTimeout(() => controller.abort(), 20)
  await consume()
  assert.ok(performance.now() - startedAt < 250)
})

test('Pi Model 工具超时形成可引用失败事实', async () => {
  const timeoutFact = 'fact:tool-error:fetch_financial_context:0'
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
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: [],
    fetchFinancialContext: async (_symbol, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { facts: [] }
    },
  })) events.push(event)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result' && event.entry.isError))
})

test('Pi Model 不允许工具越过当前分析标的', async () => {
  const deniedFact = 'fact:tool-error:fetch_financial_context:0'
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
    symbol: 'NVDA', systemPrompt: 'system', userPrompt: 'user', knownFacts: [],
    fetchFinancialContext: async () => { called = true; return { facts: [] } },
  })) events.push(event)
  assert.equal(called, false)
  assert.ok(events.some((event) => event.type === 'trace' && event.entry.type === 'tool_result' && event.entry.isError))
})
