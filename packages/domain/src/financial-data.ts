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

export type QuoteSnapshot = {
  symbol: string
  price: number | null
  previousClose?: number | null
  observedAt: string | null
  source: string | null
  degraded: boolean
  sources: unknown[]
}
