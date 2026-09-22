import type { FinancialFact, FinancialContext, FactQueryResult, PaginatedFactQueryResult } from '../../../src/adapters/financial-data-client.js'

export type FixtureCall = {
  tool: string
  params: Record<string, unknown>
  startedAt: string
  completedAt: string
  result: unknown
  isError: boolean
}

export type FixtureOptions = {
  symbol?: string
  missingQuote?: boolean
  missingFundamentals?: boolean
  missingValuation?: boolean
  missingNews?: boolean
  missingTechnical?: boolean
  toolErrors?: string[]
  insufficientNewsSources?: boolean
  latencyMs?: Partial<Record<string, number>>
}

const observedAt = '2026-09-18T14:30:00.000Z'
const fetchedAt = '2026-09-18T14:35:00.000Z'

function financialFact(
  id: string, type: string, value: unknown, source: string,
  options: { evidenceLevel?: string; sourceReference?: string; observedAt?: string } = {},
): FinancialFact {
  return {
    id, type, value, observedAt: options.observedAt ?? observedAt,
    fetchedAt, source, sourceReference: options.sourceReference ?? `https://fixture.test/${encodeURIComponent(id)}`,
    ...(options.evidenceLevel ? { evidenceLevel: options.evidenceLevel } : {}),
  }
}

function paginated<T extends FactQueryResult>(result: T): T & {
  returnedCount: number; totalCount: number; nextCursor: string | null; truncated: boolean
} {
  return { ...result, returnedCount: result.facts.length, totalCount: result.facts.length, nextCursor: null, truncated: false }
}

export function createFixtureWorld(options: FixtureOptions = {}) {
  const symbol = (options.symbol ?? 'NVDA').toUpperCase()
  const errors = new Set(options.toolErrors ?? [])
  const calls: FixtureCall[] = []
  const key = symbol.toLowerCase()
  const id = (suffix: string) => `fact:${key}:${suffix}`

  const quote = financialFact(id('quote:2026-09-18'), 'quote', {
    price: 217.5, changePct: 1.4, currency: 'USD',
  }, 'fixture_market', { sourceReference: 'https://fixture.test/quote' })
  const bars = Array.from({ length: 20 }, (_, index) => financialFact(
    id(`bar:2026-08-${String(21 + index).padStart(2, '0')}`), 'daily_bar',
    { date: `2026-08-${21 + index}`, open: 200 + index, high: 204 + index, low: 198 + index, close: 202 + index, volume: 1_000_000 + index * 10_000 },
    'fixture_market',
  ))
  const newsCandidate = financialFact(id('news:candidate:1'), 'news_candidate', {
    title: `${symbol} 发布新一代产品并上调指引`,
    url: 'https://fixture.test/news/1', publishedAt: '2026-09-17', source: 'fixture_news',
  }, 'fixture_news', { evidenceLevel: 'title_only' })
  const verifiedNews = financialFact(id('news:document:1'), 'news_document', {
    title: `${symbol} 发布新一代产品并上调指引`,
    summary: '公司发布新一代产品，并上调本季度收入指引。',
    url: 'https://fixture.test/news/1', publishedAt: '2026-09-17',
  }, 'fixture_news', { evidenceLevel: 'verified_news' })
  const webLead = financialFact(id('web:lead:1'), 'news_candidate', {
    title: `${symbol} 行业需求回暖，供应链调查显示订单改善`,
    url: 'https://fixture.test/web/1', publishedAt: '2026-09-18', source: 'fixture_web',
  }, 'fixture_web', { evidenceLevel: 'lead' })
  const officialEvent = financialFact(id('event:official:1'), 'company_event', {
    title: `${symbol} 向 SEC 提交 8-K`,
    form: '8-K', filedAt: '2026-09-17',
  }, 'fixture_official', { evidenceLevel: 'official_company_event' })
  const financialOverview = financialFact(id('financial:overview:2026Q2'), 'financial_overview', {
    period: '2026-06-30', fiscalPeriod: 'Q2 FY2026', dilutedEps: 1.05, revenue: 30_100_000_000,
    netIncome: 8_200_000_000, operatingCashFlow: 9_500_000_000, grossMargin: 0.74,
  }, 'fixture_filing', { evidenceLevel: 'reported_financial' })
  const metricSeries = financialFact(id('financial:metric:revenue:ttm'), 'financial_metric', {
    metric: 'revenue', period: 'TTM', value: 88_300_000_000, growthPct: 0.18,
  }, 'fixture_filing', { evidenceLevel: 'deterministic_financial_metric' })
  const valuationInput = financialFact(id('financial:metric:eps:ttm'), 'deterministic_financial_metric', {
    metric: 'dilutedEps', period: 'TTM', value: 3.85,
  }, 'fixture_filing', { evidenceLevel: 'deterministic_financial_metric' })
  const valuation = financialFact(id('valuation:pe:2026-09-18'), 'deterministic_valuation', {
    status: 'available', method: 'pe_multiple', formula: 'TTM diluted EPS × peer median PE',
    unit: 'USD/share', unitConversion: '1 USD = 1 USD/share', asOf: '2026-09-18',
    inputs: [valuationInput.id], range: { low: 205, high: 245 },
  }, 'fixture_engine', { evidenceLevel: 'deterministic_valuation' })
  const filing = financialFact(id('filing:10q:2026Q2'), 'filing_document', {
    form: '10-Q', filedAt: '2026-07-30', period: '2026-06-30', excerpt: '收入同比增长，毛利率提升。',
  }, 'fixture_sec', { evidenceLevel: 'official_filing' })

  const technical = financialFact(id('technical:evidence:2026-09-18'), 'technical_evidence', {
    actualStart: '2025-09-18', actualEnd: '2026-09-18', totalBarCount: 252,
    structures: {
      '20d': { status: 'available', barCount: 20, returnPct: 0.05, high: 230, low: 190 },
      '60d': { status: 'available', barCount: 60, returnPct: 0.12, high: 230, low: 175 },
      '120d': { status: 'available', barCount: 120, returnPct: 0.22, high: 230, low: 150 },
      '252d': { status: 'available', barCount: 252, returnPct: 0.55, high: 230, low: 120 },
    },
    indicators: {
      ma_5: 216.2, ma_20: 210.4, rsi_14: 58.2, annualized_volatility: 0.34,
      max_drawdown: -0.11, volume_ratio_5_to_20: 1.12,
    },
    macd: { line: 2.1, signal: 1.7, histogram: 0.4 },
    volatility: { annualized: 0.34 },
    drawdown: { maximum: -0.11 },
    volumePrice: { volumeRatio5To20: 1.12 },
    keyLevels: { support: 205, resistance: 228 },
    conflicts: ['20d_vs_252d'],
  }, 'fixture_engine', { evidenceLevel: 'deterministic_technical' })

  const allFacts = [
    quote, ...bars, newsCandidate, verifiedNews, officialEvent,
    financialOverview, metricSeries, valuationInput, valuation, filing, technical,
  ]

  const record = async <T>(tool: string, params: Record<string, unknown>, result: T): Promise<T> => {
    const startedAt = new Date().toISOString()
    const latency = options.latencyMs?.[tool] ?? 0
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency))
    const call: FixtureCall = {
      tool, params, startedAt, completedAt: new Date().toISOString(), result, isError: errors.has(tool),
    }
    calls.push(call)
    if (errors.has(tool)) throw new Error(`${tool}_fixture_error`)
    return result
  }

  const context = (): FinancialContext => {
    const facts = allFacts.filter((fact) => {
      if (options.missingQuote && (fact.type === 'quote' || fact.type === 'daily_bar')) return false
      if (options.missingFundamentals && ['financial_overview', 'financial_metric', 'filing_document', 'deterministic_financial_metric'].includes(fact.type)) return false
      if (options.missingValuation && fact.type === 'deterministic_valuation') return false
      if (options.missingNews && ['news_candidate', 'news_document', 'company_event'].includes(fact.type)) return false
      if (options.missingTechnical && fact.type === 'technical_evidence') return false
      return true
    })
    const gaps: unknown[] = []
    if (options.missingQuote) gaps.push({ capability: 'quote', reason: 'fixture_unavailable', impact: '无法形成行情判断' })
    if (options.missingFundamentals) gaps.push({ capability: 'fundamentals', reason: 'fixture_unavailable', impact: '无法形成基本面判断' })
    if (options.missingValuation) gaps.push({ capability: 'valuation', reason: 'fixture_unavailable', impact: '无法形成目标价' })
    if (options.missingNews) gaps.push({ capability: 'news', reason: 'fixture_unavailable', impact: '无法形成消息面判断' })
    if (options.missingTechnical) gaps.push({ capability: 'technical', reason: 'fixture_unavailable', impact: '无法形成技术面判断' })
    return {
      symbol, facts, gaps, indicators: {}, source: 'fixture',
      capabilities: {
        quote: options.missingQuote ? 'unavailable' : 'available',
        news: options.missingNews ? 'unavailable' : 'available',
        fundamentals: options.missingFundamentals ? 'unavailable' : 'available',
        valuation: options.missingValuation ? 'unavailable' : 'available',
        technical: options.missingTechnical ? 'unavailable' : 'available',
      },
    }
  }

  const newsReasons = [
    { source: 'fixture_primary', reason: 'title_only' },
    { source: 'fixture_secondary', reason: 'empty' },
    { source: 'fixture_tertiary', reason: 'irrelevant' },
  ]
  const newsCandidates = () => paginated({
    facts: options.missingNews ? [] : [newsCandidate, officialEvent],
    sources: [{ source: 'fixture_news', acceptedCount: 1 }],
    ...(options.insufficientNewsSources ? {
      eligibility: { normalizedQuery: `${symbol} 近期公司新闻 公告 事件`, reasons: newsReasons },
    } : {
      eligibility: { normalizedQuery: `${symbol} 近期公司新闻 公告 事件`, reasons: [] },
    }),
  })
  const webSearch = () => ({
    facts: options.missingNews ? [] : [webLead],
    sources: [{ source: 'fixture_web' }],
  })

  return {
    symbol,
    options,
    calls,
    facts: { quote, bars, newsCandidate, verifiedNews, officialEvent, webLead, financialOverview, metricSeries, valuationInput, valuation, filing, technical },
    allFacts,
    context,
    async fetchFinancialContext(requested: string): Promise<FinancialContext> {
      const result = context()
      return record('fetch_financial_context', { symbol: requested }, result)
    },
    async searchNewsCandidates(query: string): Promise<FactQueryResult> {
      return record('search_news_candidates', { query }, newsCandidates())
    },
    async searchWebEvidence(query: string): Promise<FactQueryResult> {
      return record('search_web_evidence', { query }, webSearch())
    },
    async readNewsDocument(candidate: FinancialFact): Promise<FactQueryResult> {
      const result = paginated({ facts: [candidate.id.includes('web') ? verifiedNews : verifiedNews], sources: [{ source: candidate.source }], excerpt: 'fixture 正文已核实。' })
      return record('read_news_document', { factId: candidate.id }, result)
    },
    async listCompanyEvents(requested: string): Promise<FactQueryResult> {
      return record('list_company_events', { symbol: requested }, paginated({ facts: options.missingNews ? [] : [officialEvent], sources: [{ source: 'fixture_official' }] }))
    },
    async listOfficialCompanyEvents(requested: string): Promise<FactQueryResult> {
      return record('list_official_company_events', { symbol: requested }, paginated({ facts: options.missingNews ? [] : [officialEvent], sources: [{ source: 'fixture_official' }] }))
    },
    async getFinancialOverview(requested: string) {
      return record('get_financial_overview', { symbol: requested }, {
        facts: options.missingFundamentals ? [] : [financialOverview],
        overview: options.missingFundamentals ? {} : { period: '2026-06-30', revenue: 30_100_000_000 },
        sources: [{ source: 'fixture_filing' }],
      })
    },
    async getFinancialMetricSeries(requested: string, metric: string, cursor: string | undefined): Promise<PaginatedFactQueryResult> {
      const facts = options.missingFundamentals ? [] : [metricSeries]
      return record('get_financial_metric_series', { symbol: requested, metric, cursor }, paginated({ facts, sources: [{ source: 'fixture_filing' }] }))
    },
    async getValuationEvidence(requested: string) {
      return record('get_valuation_evidence', { symbol: requested }, {
        facts: options.missingValuation || options.missingFundamentals ? [] : [valuation, valuationInput],
        currentMultiples: { pe: 56.5 },
        methods: { pe_multiple: { status: options.missingValuation ? 'unavailable' : 'available' } },
        sources: [{ source: 'fixture_engine' }],
      })
    },
    async readFilingDocument(requested: string, filingId: string, cursor: string | undefined): Promise<PaginatedFactQueryResult> {
      const facts = options.missingFundamentals ? [] : [filing]
      return record('read_filing_document', { symbol: requested, filingId, cursor }, paginated({ facts, sources: [{ source: 'fixture_sec' }], items: [] }))
    },
    async getTechnicalEvidence(requested: string) {
      return record('get_technical_evidence', { symbol: requested }, {
        facts: options.missingTechnical ? [] : [technical],
        indicators: options.missingTechnical ? {} : technical.value,
        sources: [{ source: 'fixture_engine' }],
      })
    },
    async getPriceWindow(requested: string, startDate: string, endDate: string, cursor: string | undefined): Promise<PaginatedFactQueryResult> {
      const facts = options.missingTechnical ? [] : bars.slice(0, 20)
      return record('get_price_window', { symbol: requested, startDate, endDate, cursor }, paginated({ facts, sources: [{ source: 'fixture_market' }], items: [] }))
    },
  }
}

export type FixtureWorld = ReturnType<typeof createFixtureWorld>
