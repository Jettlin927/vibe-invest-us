import type {
  FactQueryResult, FinancialContext, FinancialFact, PaginatedFactQueryResult,
} from './financial-data-client.js'
import type { ConversationToolExecutor } from './model.js'
import { validateReportCandidate } from './report-validation.js'
import type { AnalysisReport } from './model.js'

export type ResearchCapabilityOptions = {
  fetchFinancialContext?: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNewsCandidates?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchWebEvidence?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  readNewsDocument?: (candidate: FinancialFact, signal: AbortSignal) => Promise<FactQueryResult>
  listCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  getFinancialOverview?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; overview: Record<string, unknown>; sources?: unknown[] }>
  getFinancialMetricSeries?: (
    symbol: string, metric: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  getValuationEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; [key: string]: unknown }>
  getTechnicalEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; [key: string]: unknown }>
  getPriceWindow?: (
    symbol: string, startDate: string, endDate: string,
    cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  readFilingDocument?: (
    symbol: string, filingId: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
}

export function createResearchToolExecutor(
  options: ResearchCapabilityOptions,
  scope: { symbols?: string[] } = {},
): (input: {
  threadId: string
  knownFacts: Map<string, { id: string; [key: string]: unknown }>
}) => ConversationToolExecutor {
  const allowedSymbols = new Set((scope.symbols ?? []).map((symbol) => symbol.toUpperCase()))
  return ({ knownFacts }) => async (name, params, signal, onStart) => {
    const record = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Record<string, unknown> : {}
    const symbol = typeof record.symbol === 'string' && record.symbol.trim()
      ? record.symbol.trim().toUpperCase()
      : allowedSymbols.size === 1 ? [...allowedSymbols][0]! : ''
    const checkSymbol = () => {
      if (!symbol && ['fetch_financial_context', 'get_financial_overview', 'get_financial_metric_series',
        'get_valuation_evidence', 'get_technical_evidence', 'get_price_window',
        'read_filing_document', 'list_company_events'].includes(name)) {
        throw new Error('tool_symbol_required')
      }
      if (allowedSymbols.size && symbol && !allowedSymbols.has(symbol)) {
        throw new Error('tool_symbol_not_allowed')
      }
    }
    const run = async (task: () => Promise<unknown>) => {
      await onStart()
      const result = await task()
      rememberFacts(knownFacts, result)
      return { result: asRecord(result), isError: false }
    }
    try {
      checkSymbol()
      if (name === 'fetch_financial_context' && options.fetchFinancialContext) {
        return run(() => options.fetchFinancialContext!(symbol, signal))
      }
      if (name === 'search_news_candidates' && options.searchNewsCandidates) {
        return run(() => options.searchNewsCandidates!(stringParam(record, 'query'), signal))
      }
      if (name === 'search_web_evidence' && options.searchWebEvidence) {
        return run(() => options.searchWebEvidence!(stringParam(record, 'query'), signal))
      }
      if (name === 'read_news_document' && options.readNewsDocument) {
        const factId = stringParam(record, 'factId')
        const candidate = knownFacts.get(factId)
        if (!candidate) throw new Error('news_candidate_not_found')
        return run(() => options.readNewsDocument!(candidate as FinancialFact, signal))
      }
      if (name === 'list_company_events' && options.listCompanyEvents) {
        return run(() => options.listCompanyEvents!(symbol, signal))
      }
      if (name === 'get_financial_overview' && options.getFinancialOverview) {
        return run(() => options.getFinancialOverview!(symbol, signal))
      }
      if (name === 'get_financial_metric_series' && options.getFinancialMetricSeries) {
        return run(() => options.getFinancialMetricSeries!(
          symbol, stringParam(record, 'metric'), optionalString(record, 'cursor'), signal,
        ))
      }
      if (name === 'get_valuation_evidence' && options.getValuationEvidence) {
        return run(() => options.getValuationEvidence!(symbol, signal))
      }
      if (name === 'get_technical_evidence' && options.getTechnicalEvidence) {
        return run(() => options.getTechnicalEvidence!(symbol, signal))
      }
      if (name === 'get_price_window' && options.getPriceWindow) {
        return run(() => options.getPriceWindow!(
          symbol, stringParam(record, 'startDate'), stringParam(record, 'endDate'),
          optionalString(record, 'cursor'), signal,
        ))
      }
      if (name === 'read_filing_document' && options.readFilingDocument) {
        return run(() => options.readFilingDocument!(
          symbol, stringParam(record, 'filingId'), optionalString(record, 'cursor'), signal,
        ))
      }
      if (name === 'create_research_report') {
        await onStart()
        const validation = validateReportCandidate(record, {
          role: 'main', knownFacts: [...knownFacts.values()] as never,
        })
        if (!validation.ok) return {
          result: { error: 'report_validation_failed', errors: validation.errors, submitted: false },
          isError: true,
        }
        const report = validation.report as Record<string, unknown>
        return {
          result: { submitted: true, report: { title: report.title ?? null } },
          isError: false, terminate: true,
          report: report as unknown as AnalysisReport,
          reportVersion: { kind: 'integrated', report },
        }
      }
      await onStart()
      return { result: { error: 'tool_not_available', facts: [] }, isError: true }
    } catch (error) {
      return {
        result: { error: error instanceof Error ? error.message : String(error), facts: [] },
        isError: true,
      }
    }
  }
}

function rememberFacts(
  knownFacts: Map<string, { id: string; [key: string]: unknown }>, value: unknown,
) {
  const facts = value && typeof value === 'object' && Array.isArray((value as { facts?: unknown }).facts)
    ? (value as { facts: Array<{ id?: unknown }> }).facts : []
  for (const fact of facts) if (typeof fact.id === 'string') knownFacts.set(fact.id, fact as { id: string })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : { value }
}

function stringParam(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' ? value[key] as string : ''
}

function optionalString(value: Record<string, unknown>, key: string) {
  const result = stringParam(value, key)
  return result || undefined
}
