import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai'
import type { FixtureWorld } from '../harness/fixture.js'

export function toolTurn(calls: Array<{ name: string; args: Record<string, unknown> }>): FauxResponseStep {
  return fauxAssistantMessage(
    calls.map(({ name, args }) => fauxToolCall(name, args)),
    { stopReason: 'toolUse' },
  )
}

export function textTurn(text: string): FauxResponseStep {
  const message = fauxAssistantMessage([{ type: 'text', text }])
  return { ...message, stopReason: 'stop' as const }
}

export function declineSpecialistCalls(symbol: string): Array<{ name: string; args: Record<string, unknown> }> {
  return [
    { name: 'run_news_analysis', args: { launch: false, researchQuestion: `${symbol} 近期新闻是否改变判断`, reason: '快照已包含足够市场信息，不需要独立新闻专项' } },
    { name: 'run_fundamental_analysis', args: { launch: false, researchQuestion: `${symbol} 正式财务是否改变判断`, reason: '本次只评估短期市场结构，不需要独立基本面专项' } },
    { name: 'run_technical_analysis', args: { launch: false, researchQuestion: `${symbol} 多周期技术结构是否改变判断`, reason: '快照技术证据不足，暂不启动独立技术专项' } },
  ]
}

export function integratedReport(fixture: FixtureWorld, options: {
  statuses?: Array<{ domain: string; status: string; impact: string }>
  title?: string
} = {}): Record<string, unknown> {
  const quote = fixture.facts.quote.id
  const bar = fixture.facts.bars[0]?.id ?? quote
  const statuses = options.statuses ?? [
    { domain: 'news', status: 'not_started', impact: '主 Agent 决定不启动消息面专项' },
    { domain: 'fundamental_valuation', status: 'not_started', impact: '主 Agent 决定不启动基本面专项' },
    { domain: 'technical', status: 'not_started', impact: '主 Agent 决定不启动技术面专项' },
  ]
  return {
    kind: 'integrated',
    availability: 'available',
    status: 'completed',
    gaps: [],
    limitations: [],
    specialistStatuses: statuses,
    specialistReferences: [],
    title: options.title ?? `${fixture.symbol} 一至四周综合分析`,
    marketState: '价格位于短期均线之上，短线结构偏强。',
    trend: '未来一至四周偏强震荡，需观察量能持续性。',
    drivers: ['近期价格与成交量保持温和上行。'],
    supportingEvidence: [quote, bar],
    contraryEvidence: [bar],
    scenarios: [{ name: '延续', condition: '守住 205 支撑', outcome: '上行测试 228 阻力' }],
    invalidationConditions: ['跌破 205 支撑'],
    valuation: null,
    personalImpact: null,
    conditionalSuggestion: null,
    keyJudgments: [{
      type: 'market', statement: '短期价格结构偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: [quote], contraryEvidence: [bar],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破 205 支撑'],
      affectedByMissingDomains: ['news', 'fundamental_valuation', 'technical'],
    }],
  }
}

export function firstResearchScript(fixture: FixtureWorld, report = integratedReport(fixture)): FauxResponseStep[] {
  return [
    toolTurn([
      { name: 'fetch_financial_context', args: { symbol: fixture.symbol } },
      ...declineSpecialistCalls(fixture.symbol),
    ]),
    toolTurn([{ name: 'submit_analysis_report', args: report }]),
  ]
}

export function gapIntegratedReport(fixture: FixtureWorld): Record<string, unknown> {
  return {
    kind: 'integrated', availability: 'partial', status: 'partial', gaps: [
      { capability: 'quote', reason: 'fixture_quote_unavailable', impact: '无法判断短期走势' },
      { capability: 'news', reason: 'fixture_news_unavailable', impact: '无法识别新闻催化' },
      { capability: 'fundamentals', reason: 'fixture_fundamentals_unavailable', impact: '无法评估财务与估值' },
      { capability: 'technical', reason: 'fixture_technical_unavailable', impact: '无法判断技术结构' },
    ],
    limitations: ['关键行情、新闻、财务与技术数据均不可用，本报告不提供方向判断。'],
    specialistStatuses: [
      { domain: 'news', status: 'not_started', impact: '数据不可用，未启动消息面专项' },
      { domain: 'fundamental_valuation', status: 'not_started', impact: '数据不可用，未启动基本面专项' },
      { domain: 'technical', status: 'not_started', impact: '数据不可用，未启动技术面专项' },
    ],
    specialistReferences: [],
    title: `${fixture.symbol} 数据受限说明`,
    marketState: '关键行情数据缺失',
    trend: '无法生成走势判断',
    drivers: [],
    supportingEvidence: [],
    contraryEvidence: [],
    scenarios: [],
    invalidationConditions: [],
    valuation: null,
    personalImpact: null,
    conditionalSuggestion: null,
    keyJudgments: [],
  }
}

export function gapResearchScript(fixture: FixtureWorld): FauxResponseStep[] {
  return [
    toolTurn([
      { name: 'fetch_financial_context', args: { symbol: fixture.symbol } },
      ...declineSpecialistCalls(fixture.symbol),
    ]),
    toolTurn([{ name: 'submit_analysis_report', args: gapIntegratedReport(fixture) }]),
  ]
}

export function hiddenToolScript(fixture: FixtureWorld): FauxResponseStep[] {
  return [
    toolTurn([{ name: 'bash', args: { command: 'touch /tmp/should-not-exist' } }]),
    toolTurn([
      { name: 'fetch_financial_context', args: { symbol: fixture.symbol } },
      ...declineSpecialistCalls(fixture.symbol),
    ]),
    toolTurn([{ name: 'submit_analysis_report', args: integratedReport(fixture) }]),
  ]
}

export const blockedTextStep: FauxResponseStep = async (_context, options) => {
  const signal = options?.signal
  await new Promise<void>((resolve) => {
    if (signal === undefined) {
      setTimeout(resolve, 5_000)
      return
    }
    if (signal.aborted === true) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  return fauxAssistantMessage([{ type: 'text', text: '迟到的模型回复不应产生新报告。' }])
}

export function flatIntegratedReport(fixture: FixtureWorld): Record<string, unknown> {
  const overview = fixture.facts.financialOverview.id
  return {
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    title: `${fixture.symbol} 扁平模式综合分析`, marketState: '价格与财务指标均可用。',
    trend: '未来一至四周偏强震荡。', drivers: ['收入与 EPS 保持增长。'],
    supportingEvidence: [overview], contraryEvidence: [],
    scenarios: [{ name: '延续', condition: '收入增速保持', outcome: '趋势延续' }],
    invalidationConditions: ['收入增速转负'], valuation: null, personalImpact: null,
    conditionalSuggestion: null,
    keyJudgments: [{
      type: 'fundamental', statement: '最新财期收入与 EPS 仍保持增长', direction: 'bullish',
      confidence: 'medium', supportingEvidence: [overview], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['收入增速转负'],
      affectedByMissingDomains: [],
    }],
  }
}

export function flatModeScript(fixture: FixtureWorld): FauxResponseStep[] {
  return [
    toolTurn([{ name: 'get_financial_overview', args: { symbol: 'MSFT' } }]),
    toolTurn([{ name: 'get_financial_overview', args: { symbol: fixture.symbol } }]),
    toolTurn([{ name: 'submit_analysis_report', args: flatIntegratedReport(fixture) }]),
  ]
}

export function flatNewsIntegratedReport(fixture: FixtureWorld): Record<string, unknown> {
  const verified = fixture.facts.verifiedNews.id
  return {
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    title: `${fixture.symbol} 扁平模式消息面报告`, marketState: '新闻正文已核实。',
    trend: '消息面暂无反向证据。', drivers: ['产品与指引变化。'],
    supportingEvidence: [verified], contraryEvidence: [],
    scenarios: [{ name: '延续', condition: '无反向公告', outcome: '消息面维持正面' }],
    invalidationConditions: ['出现重大反向公告'], valuation: null, personalImpact: null,
    conditionalSuggestion: null, keyJudgments: [{
      type: 'news', statement: '已核实新闻支持近期正面催化', direction: 'bullish',
      confidence: 'medium', supportingEvidence: [verified], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['出现重大反向公告'],
      affectedByMissingDomains: [],
    }],
  }
}

export function flatWebSearchGateScript(fixture: FixtureWorld): FauxResponseStep[] {
  const query = `${fixture.symbol} 近期公司新闻 公告 事件`
  return [
    toolTurn([{ name: 'search_news_candidates', args: { query } }]),
    toolTurn([{ name: 'search_web_evidence', args: { query } }]),
    toolTurn([{ name: 'read_news_document', args: { factId: fixture.facts.webLead.id } }]),
    toolTurn([{ name: 'submit_analysis_report', args: flatNewsIntegratedReport(fixture) }]),
  ]
}
