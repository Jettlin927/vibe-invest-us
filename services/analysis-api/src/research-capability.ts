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
  listOfficialCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
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
  listPortfolioSymbols?: () => Promise<string[]>
  fetchMarketPrices?: (
    symbols: string[], signal: AbortSignal,
  ) => Promise<Record<string, number>>
  getPortfolioContext?: (
    symbol: string, marketPrices: Record<string, number>,
  ) => Promise<unknown>
}

export function createResearchToolExecutor(
  options: ResearchCapabilityOptions,
  scope: { symbols?: string[] } = {},
): (input: {
  threadId: string
  knownFacts: Map<string, { id: string; [key: string]: unknown }>
}) => ConversationToolExecutor {
  return ({ knownFacts }) => async (name, params, signal, onStart) => {
    const allowedSymbols = new Set((scope.symbols ?? []).map((symbol) => symbol.toUpperCase()))
    const record = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Record<string, unknown> : {}
    const symbol = typeof record.symbol === 'string' && record.symbol.trim()
      ? record.symbol.trim().toUpperCase()
      : allowedSymbols.size === 1 ? [...allowedSymbols][0]! : ''
    const checkSymbol = () => {
      if (!symbol && ['fetch_financial_context', 'get_financial_overview', 'get_financial_metric_series',
        'get_valuation_evidence', 'get_technical_evidence', 'get_price_window',
        'read_filing_document', 'list_company_events', 'get_company_dossier',
        'get_market_structure', 'get_research_context', 'get_portfolio_exposure'].includes(name)) {
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
      if (name === 'get_research_context') {
        if (!options.fetchFinancialContext) return run(async () => ({
          facts: [], gaps: [{ capability: name, reason: 'tool_not_available' }],
        }))
        return run(() => options.fetchFinancialContext!(symbol, signal))
      }
      if (name === 'compare_securities') {
        const symbols = Array.isArray(record.symbols)
          ? [...new Set(record.symbols.flatMap((item) => (
            typeof item === 'string' && item.trim() ? [item.trim().toUpperCase()] : []
          )))] : []
        if (symbols.length < 2 || symbols.length > 5) throw new Error('comparison_symbols_invalid')
        if (allowedSymbols.size && symbols.some((item) => !allowedSymbols.has(item))) {
          throw new Error('tool_symbol_not_allowed')
        }
        return run(async () => {
          const rows = await Promise.all(symbols.map(async (comparisonSymbol) => {
            const tasks = [
              ['fundamentals', options.getFinancialOverview
                ? () => options.getFinancialOverview!(comparisonSymbol, signal) : undefined],
              ['valuation', options.getValuationEvidence
                ? () => options.getValuationEvidence!(comparisonSymbol, signal) : undefined],
              ['market_structure', options.getTechnicalEvidence
                ? () => options.getTechnicalEvidence!(comparisonSymbol, signal) : undefined],
            ] as const
            const settled = await Promise.all(tasks.map(async ([capability, execute]) => {
              if (!execute) return { capability, error: 'tool_not_available' }
              try { return { capability, result: await execute() } }
              catch (error) {
                return { capability, error: error instanceof Error ? error.message : String(error) }
              }
            }))
            const result = (capability: string) => settled.find((item) => (
              item.capability === capability
            ))?.result
            const fundamentals = result('fundamentals')
            const valuation = result('valuation')
            const market = result('market_structure')
            return {
              comparison: {
                symbol: comparisonSymbol,
                ...(fundamentals?.overview && typeof fundamentals.overview === 'object'
                  ? { overview: selectFields(asRecord(fundamentals.overview), overviewKeys) } : {}),
                ...selectFields(valuation, valuationResultKeys),
                ...(market ? { marketStructure: selectFields(market, marketStructureKeys) } : {}),
              },
              facts: settled.flatMap((item) => Array.isArray(item.result?.facts) ? item.result.facts : []),
              sources: settled.flatMap((item) => Array.isArray(item.result?.sources) ? item.result.sources : []),
              gaps: settled.flatMap((item) => item.error
                ? [{ capability: item.capability, symbol: comparisonSymbol, reason: item.error }] : []),
            }
          }))
          return {
            comparisons: rows.map(({ comparison }) => comparison),
            facts: rows.flatMap(({ facts }) => facts),
            sources: rows.flatMap(({ sources }) => sources),
            gaps: rows.flatMap(({ gaps }) => gaps),
          }
        })
      }
      if (name === 'get_portfolio_exposure') {
        if (!options.listPortfolioSymbols || !options.fetchMarketPrices || !options.getPortfolioContext) {
          return run(async () => ({
            facts: [], position: null, portfolio: {},
            gaps: [{ capability: 'portfolio_exposure', reason: 'tool_not_available' }],
          }))
        }
        return run(async () => {
          const symbols = await options.listPortfolioSymbols!()
          const prices = await options.fetchMarketPrices!(symbols, signal)
          const context = asRecord(await options.getPortfolioContext!(symbol, prices))
          return {
            facts: [], position: context.position ?? null,
            portfolio: asRecord(context.portfolio), gaps: [],
          }
        })
      }
      if (name === 'search_news_candidates' && options.searchNewsCandidates) {
        return run(() => options.searchNewsCandidates!(stringParam(record, 'query'), signal))
      }
      if (name === 'search_evidence') {
        return run(async () => {
          const query = stringParam(record, 'query')
          const tasks: Array<{
            capability: string
            execute: () => Promise<FactQueryResult>
          }> = []
          if (options.searchNewsCandidates) tasks.push({
            capability: 'structured_news',
            execute: () => options.searchNewsCandidates!(query, signal),
          })
          if (symbol && options.listOfficialCompanyEvents) tasks.push({
            capability: 'official_company_events',
            execute: () => options.listOfficialCompanyEvents!(symbol, signal),
          })
          const settled = await Promise.all(tasks.map(async ({ capability, execute }) => {
            try { return { capability, result: await execute() } }
            catch (error) {
              return { capability, error: error instanceof Error ? error.message : String(error) }
            }
          }))
          const results = settled.flatMap((item) => item.result ? [item.result] : [])
          const newsResult = settled.find(({ capability }) => capability === 'structured_news')?.result
          const rawEligibility = asRecord(newsResult?.eligibility)
          const hasOfficialEvent = results.some((result) => result.facts.some((fact) => (
            fact.evidenceLevel === 'official_company_event'
          )))
          const eligibility = Object.keys(rawEligibility).length
            ? hasOfficialEvent ? {
                ...rawEligibility, eligible: false,
                reasons: [
                  ...(Array.isArray(rawEligibility.reasons) ? rawEligibility.reasons : []),
                  { source: 'official_company_events', reason: 'qualified' },
                ],
              } : rawEligibility
            : undefined
          const gaps = [
            ...(!options.searchNewsCandidates
              ? [{ capability: 'structured_news', reason: 'tool_not_available' }] : []),
            ...(symbol && !options.listOfficialCompanyEvents
              ? [{ capability: 'official_company_events', reason: 'tool_not_available' }] : []),
            ...settled.flatMap((item) => item.error
              ? [{ capability: item.capability, reason: item.error }] : []),
            ...results.flatMap((result) => resultGaps(result)),
          ]
          return {
            facts: results.flatMap(({ facts }) => facts),
            sources: results.flatMap(({ sources }) => sources ?? []),
            gaps,
            ...(eligibility ? { eligibility } : {}),
          }
        })
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
      if (name === 'read_evidence') {
        const evidenceId = stringParam(record, 'evidenceId')
        const evidence = knownFacts.get(evidenceId) as FinancialFact | undefined
        if (!evidence) throw new Error('evidence_not_found')
        const value = asRecord(evidence.value)
        const filingId = stringParam(value, 'filingId')
        const evidenceSymbol = stringParam(value, 'symbol').toUpperCase()
        if (filingId && evidenceSymbol && options.readFilingDocument
          && ['official_company_event', 'official_filing'].includes(evidence.evidenceLevel ?? '')) {
          return run(() => options.readFilingDocument!(
            evidenceSymbol, filingId, optionalString(record, 'cursor'), signal,
          ))
        }
        if (options.readNewsDocument
          && ['news', 'company_event', 'web_search_lead'].includes(evidence.type)) {
          return run(() => options.readNewsDocument!(evidence, signal))
        }
        throw new Error('evidence_not_readable')
      }
      if (name === 'list_company_events' && options.listCompanyEvents) {
        return run(() => options.listCompanyEvents!(symbol, signal))
      }
      if (name === 'get_financial_overview' && options.getFinancialOverview) {
        return run(() => options.getFinancialOverview!(symbol, signal))
      }
      if (name === 'get_company_dossier') {
        return run(async () => {
          const tasks: Array<{ capability: string; execute: () => Promise<Record<string, unknown>> }> = []
          if (options.getFinancialOverview) tasks.push({
            capability: 'fundamentals', execute: () => options.getFinancialOverview!(symbol, signal),
          })
          if (options.getValuationEvidence) tasks.push({
            capability: 'valuation', execute: () => options.getValuationEvidence!(symbol, signal),
          })
          if (options.listOfficialCompanyEvents) tasks.push({
            capability: 'official_company_events',
            execute: () => options.listOfficialCompanyEvents!(symbol, signal),
          })
          const settled = await Promise.all(tasks.map(async ({ capability, execute }) => {
            try { return { capability, result: await execute() } }
            catch (error) {
              return { capability, error: error instanceof Error ? error.message : String(error) }
            }
          }))
          const available = settled.flatMap((item) => item.result ? [item.result] : [])
          const fundamentals = settled.find(({ capability }) => capability === 'fundamentals')?.result
          const valuation = settled.find(({ capability }) => capability === 'valuation')?.result
          const valuationFields = selectFields(valuation, valuationResultKeys)
          return {
            facts: available.flatMap((result) => Array.isArray(result.facts) ? result.facts : []),
            sources: available.flatMap((result) => Array.isArray(result.sources) ? result.sources : []),
            gaps: [
              ...(!options.getFinancialOverview
                ? [{ capability: 'fundamentals', reason: 'tool_not_available' }] : []),
              ...(!options.getValuationEvidence
                ? [{ capability: 'valuation', reason: 'tool_not_available' }] : []),
              ...(!options.listOfficialCompanyEvents
                ? [{ capability: 'official_company_events', reason: 'tool_not_available' }] : []),
              ...settled.flatMap((item) => item.error
                ? [{ capability: item.capability, reason: item.error }] : []),
              ...available.flatMap((result) => resultGaps(result)),
            ],
            ...(fundamentals?.overview && typeof fundamentals.overview === 'object'
              ? { overview: selectFields(asRecord(fundamentals.overview), overviewKeys) } : {}),
            ...valuationFields,
          }
        })
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
      if (name === 'get_market_structure') {
        if (!options.getTechnicalEvidence) return run(async () => ({
          facts: [], gaps: [{ capability: name, reason: 'tool_not_available' }],
        }))
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

const overviewKeys = ['symbol', 'latestPeriod', 'qualityFlags']
const valuationResultKeys = [
  'symbol', 'authorizedComparables', 'comparables', 'excludedComparables',
  'currentMultiples', 'historicalRanges', 'methods',
]
const marketStructureKeys = [
  'symbol', 'actualStart', 'actualEnd', 'totalBarCount', 'sampling', 'structures',
  'indicators', 'volatility', 'drawdown', 'volumePrice', 'keyLevels', 'conflicts',
]

function selectFields(value: Record<string, unknown> | undefined, keys: string[]) {
  if (!value) return {}
  return Object.fromEntries(keys.flatMap((key) => key in value ? [[key, value[key]]] : []))
}

function resultGaps(value: unknown) {
  const gaps = asRecord(value).gaps
  return Array.isArray(gaps) ? gaps : []
}
