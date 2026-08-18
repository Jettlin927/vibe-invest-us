import { isFinancialDataHealth, type FinancialDataHealth } from '@vibe-invest/contracts'

export type FinancialFact = {
  id: string
  type: string
  value: unknown
  observedAt: string
  fetchedAt: string
  source: string
  sourceReference: string
  evidenceLevel?: string
}

export type FinancialContext = {
  symbol: string
  facts: FinancialFact[]
  gaps?: unknown[]
  indicators?: unknown
  valuation?: unknown
  [key: string]: unknown
}

export type FactQueryResult = {
  facts: FinancialFact[]
  sources?: unknown[]
  excerpt?: string
  eligibility?: unknown
}

export type PaginatedFactQueryResult = FactQueryResult & {
  returnedCount: number
  totalCount: number
  nextCursor: string | null
  truncated: boolean
  items?: unknown[]
}

export type PriceWindowQueryResult = PaginatedFactQueryResult & {
  symbol: string
  actualStart: string
  actualEnd: string
  totalBarCount: number
  sampling: 'daily' | 'weekly'
}

export const MARKET_PRICE_REQUEST_TIMEOUT_MS = 30_000

export function createFinancialDataClient(baseUrl: string) {
  return {
    async health(): Promise<FinancialDataHealth> {
      const response = await fetch(new URL('/health', baseUrl), {
        signal: AbortSignal.timeout(2_000),
      })

      if (!response.ok) throw new Error(`financial_data_http_${response.status}`)

      const value: unknown = await response.json()
      if (!isFinancialDataHealth(value)) throw new Error('financial_data_contract_invalid')
      return value
    },
    async context(symbol: string, signal?: AbortSignal): Promise<FinancialContext> {
      const response = await fetch(new URL(`/v1/financial-context?symbol=${encodeURIComponent(symbol)}`, baseUrl), {
        method: 'POST',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`financial_context_http_${response.status}`)
      const value: unknown = await response.json()
      if (!isFinancialContext(value)) {
        throw new Error('financial_context_contract_invalid')
      }
      return value
    },
    async searchNews(keyword: string, signal?: AbortSignal): Promise<FactQueryResult> {
      return factQuery(`/v1/news-search?keyword=${encodeURIComponent(keyword)}`, signal)
    },
    async searchWeb(query: string, signal?: AbortSignal): Promise<FactQueryResult> {
      return factQuery(`/v1/web-search?query=${encodeURIComponent(query)}`, signal)
    },
    async readNewsDocument(candidate: FinancialFact, signal?: AbortSignal): Promise<FactQueryResult> {
      const response = await fetch(new URL('/v1/news-document', baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidate }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`financial_data_news_document_http_${response.status}`)
      const value = await response.json() as { facts?: unknown; sources?: unknown[]; excerpt?: unknown }
      if (!Array.isArray(value.facts) || !value.facts.every(isFinancialFact)) {
        throw new Error('financial_data_news_document_contract_invalid')
      }
      return {
        facts: value.facts, sources: Array.isArray(value.sources) ? value.sources : [],
        ...(typeof value.excerpt === 'string' ? { excerpt: value.excerpt } : {}),
      }
    },
    async companyEvents(symbol: string, signal?: AbortSignal): Promise<FactQueryResult> {
      return factQuery(`/v1/company-events?symbol=${encodeURIComponent(symbol)}`, signal)
    },
    async officialCompanyEvents(symbol: string, signal?: AbortSignal): Promise<FactQueryResult> {
      return factQuery(`/v1/official-company-events?symbol=${encodeURIComponent(symbol)}`, signal)
    },
    async financialOverview(symbol: string, signal?: AbortSignal) {
      const result = await rawFactQuery(
        `/v1/financial-overview?symbol=${encodeURIComponent(symbol)}`, signal,
      )
      if (!result.overview || typeof result.overview !== 'object') {
        throw new Error('financial_data_overview_contract_invalid')
      }
      return { overview: result.overview as Record<string, unknown>, facts: result.facts, sources: result.sources }
    },
    async valuationEvidence(symbol: string, signal?: AbortSignal) {
      const result = await rawFactQuery(
        `/v1/valuation-evidence?symbol=${encodeURIComponent(symbol)}`, signal,
      )
      if (typeof result.symbol !== 'string' || !Array.isArray(result.authorizedComparables)
        || !result.authorizedComparables.every((value) => typeof value === 'string')
        || !Array.isArray(result.comparables)
        || !result.currentMultiples || typeof result.currentMultiples !== 'object'
        || !result.historicalRanges || typeof result.historicalRanges !== 'object'
        || !result.methods || typeof result.methods !== 'object') {
        throw new Error('financial_data_valuation_contract_invalid')
      }
      return {
        symbol: result.symbol, authorizedComparables: result.authorizedComparables as string[],
        comparables: result.comparables as unknown[],
        currentMultiples: result.currentMultiples as Record<string, unknown>,
        historicalRanges: result.historicalRanges as Record<string, unknown>,
        methods: result.methods as Record<string, unknown>, facts: result.facts, sources: result.sources,
      }
    },
    async financialMetricSeries(
      symbol: string, metric: string, cursor?: string, signal?: AbortSignal,
    ): Promise<PaginatedFactQueryResult> {
      const query = new URLSearchParams({ symbol, metric })
      if (cursor) query.set('cursor', cursor)
      return paginatedFactQuery(`/v1/financial-metric-series?${query}`, signal)
    },
    async filingDocument(
      symbol: string, filingId: string, cursor?: string, signal?: AbortSignal,
    ): Promise<PaginatedFactQueryResult> {
      const query = new URLSearchParams({ symbol, filing_id: filingId })
      if (cursor) query.set('cursor', cursor)
      return paginatedFactQuery(`/v1/filing-document?${query}`, signal, true)
    },
    async technicalIndicators(
      symbol: string, startDate: string, endDate: string, signal?: AbortSignal,
    ): Promise<FactQueryResult> {
      const query = new URLSearchParams({ symbol, start_date: startDate, end_date: endDate })
      return factQuery(`/v1/technical-indicators?${query}`, signal)
    },
    async technicalEvidence(symbol: string, signal?: AbortSignal) {
      const result = await rawFactQuery(
        `/v1/technical-evidence?symbol=${encodeURIComponent(symbol)}`, signal,
      )
      if (typeof result.symbol !== 'string' || typeof result.actualStart !== 'string'
        || typeof result.actualEnd !== 'string' || !Number.isInteger(result.totalBarCount)
        || !result.structures || typeof result.structures !== 'object'
        || !result.indicators || typeof result.indicators !== 'object'
        || !result.volatility || typeof result.volatility !== 'object'
        || !result.drawdown || typeof result.drawdown !== 'object'
        || !result.volumePrice || typeof result.volumePrice !== 'object'
        || !result.keyLevels || typeof result.keyLevels !== 'object'
        || !Array.isArray(result.conflicts)) {
        throw new Error('financial_data_technical_evidence_contract_invalid')
      }
      return result
    },
    async priceWindow(
      symbol: string, startDate: string, endDate: string,
      cursor?: string, signal?: AbortSignal,
    ): Promise<PriceWindowQueryResult> {
      const query = new URLSearchParams({ symbol, start_date: startDate, end_date: endDate })
      if (cursor) query.set('cursor', cursor)
      const value = await rawFactQuery(`/v1/price-window?${query}`, signal)
      const page = validatePagination(value)
      if (typeof value.symbol !== 'string' || typeof value.actualStart !== 'string'
        || typeof value.actualEnd !== 'string' || !Number.isInteger(value.totalBarCount)
        || (value.sampling !== 'daily' && value.sampling !== 'weekly')) {
        throw new Error('financial_data_price_window_contract_invalid')
      }
      return {
        ...page,
        symbol: value.symbol, actualStart: value.actualStart, actualEnd: value.actualEnd,
        totalBarCount: value.totalBarCount as number, sampling: value.sampling,
      }
    },
    async quotes(symbols: string[], signal?: AbortSignal): Promise<Record<string, number>> {
      const response = await fetch(new URL('/v1/quotes', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(symbols),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(MARKET_PRICE_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(MARKET_PRICE_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`financial_data_quotes_http_${response.status}`)
      const value = await response.json() as { quotes?: Array<{ symbol?: unknown; price?: unknown }> }
      if (!Array.isArray(value.quotes)) throw new Error('financial_data_quotes_contract_invalid')
      return Object.fromEntries(value.quotes.flatMap((quote) => (
        typeof quote.symbol === 'string' && typeof quote.price === 'number'
          ? [[quote.symbol, quote.price] as const]
          : []
      )))
    },
  }

  async function factQuery(path: string, signal?: AbortSignal): Promise<FactQueryResult> {
    const value = await rawFactQuery(path, signal)
    return {
      facts: value.facts, sources: value.sources,
      ...('eligibility' in value ? { eligibility: value.eligibility } : {}),
    }
  }

  async function rawFactQuery(
    path: string, signal?: AbortSignal,
  ): Promise<Record<string, unknown> & { facts: FinancialFact[]; sources: unknown[] }> {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`financial_data_fact_query_http_${response.status}`)
    const value = await response.json() as Record<string, unknown>
    if (!Array.isArray(value.facts) || !value.facts.every(isFinancialFact)) {
      throw new Error('financial_data_fact_query_contract_invalid')
    }
    return {
      ...value, facts: value.facts as FinancialFact[],
      sources: Array.isArray(value.sources) ? value.sources : [],
    }
  }

  async function paginatedFactQuery(
    path: string, signal?: AbortSignal, includeItems = false,
  ): Promise<PaginatedFactQueryResult> {
    const value = await rawFactQuery(path, signal)
    return { ...validatePagination(value, includeItems), ...(includeItems ? { items: value.items as unknown[] } : {}) }
  }

  function validatePagination(
    value: Record<string, unknown> & { facts: FinancialFact[]; sources: unknown[] },
    requireItems = false,
  ): PaginatedFactQueryResult {
    if (!Number.isInteger(value.returnedCount) || !Number.isInteger(value.totalCount)
      || typeof value.truncated !== 'boolean'
      || !(value.nextCursor === null || typeof value.nextCursor === 'string')
      || (requireItems && !Array.isArray(value.items))) {
      throw new Error('financial_data_pagination_contract_invalid')
    }
    return {
      facts: value.facts, sources: value.sources,
      returnedCount: value.returnedCount as number, totalCount: value.totalCount as number,
      nextCursor: value.nextCursor as string | null, truncated: value.truncated,
    }
  }
}

function isFinancialContext(value: unknown): value is FinancialContext {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.symbol === 'string'
    && Array.isArray(candidate.facts)
    && candidate.facts.every(isFinancialFact)
}

function isFinancialFact(value: unknown): value is FinancialFact {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return ['id', 'type', 'observedAt', 'fetchedAt', 'source', 'sourceReference']
    .every((field) => typeof candidate[field] === 'string' && candidate[field] !== '')
    && 'value' in candidate
}
