export type RegisteredToolHandler = (
  params: unknown,
  context: Record<string, ((params?: unknown) => Promise<unknown>) | undefined>,
) => Promise<unknown>

export const registeredToolHandlers: Record<string, RegisteredToolHandler> = {
  fetch_financial_context: async (_params, context) => required(context, 'loadFinancialContext')(),
  analyze_financials: async (_params, context) => required(context, 'runFinancialSpecialist')(),
  run_news_analysis: async (params, context) => required(context, 'runNewsSpecialist')(params),
  submit_analysis_report: async (params, context) => required(context, 'submitAnalysisReport')(params),
  search_news_by_keyword: async (params, context) => required(context, 'searchNews')(params),
  get_technical_indicators: async (params, context) => required(context, 'fetchTechnicalIndicators')(params),
  search_news_candidates: async (params, context) => required(context, 'searchNewsCandidates')(params),
  read_news_document: async (params, context) => required(context, 'readNewsDocument')(params),
  list_company_events: async (params, context) => required(context, 'listCompanyEvents')(params),
  submit_specialist_report: async (params, context) => required(context, 'submitSpecialistReport')(params),
}

function required(
  context: Record<string, ((params?: unknown) => Promise<unknown>) | undefined>, name: string,
) {
  const handler = context[name]
  if (!handler) throw new Error(`tool_handler_context_missing:${name}`)
  return handler
}
