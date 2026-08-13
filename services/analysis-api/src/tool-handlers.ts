export type RegisteredToolHandler = (
  params: unknown,
  context: Record<string, ((params?: unknown) => Promise<unknown>) | undefined>,
) => Promise<unknown>

export const registeredToolHandlers: Record<string, RegisteredToolHandler> = {
  fetch_financial_context: async (_params, context) => required(context, 'loadFinancialContext')(),
  analyze_financials: async (_params, context) => required(context, 'runFinancialSpecialist')(),
  submit_analysis_report: async (params, context) => required(context, 'submitAnalysisReport')(params),
  search_news_by_keyword: async (params, context) => required(context, 'searchNews')(params),
  get_technical_indicators: async (params, context) => required(context, 'fetchTechnicalIndicators')(params),
}

function required(
  context: Record<string, ((params?: unknown) => Promise<unknown>) | undefined>, name: string,
) {
  const handler = context[name]
  if (!handler) throw new Error(`tool_handler_context_missing:${name}`)
  return handler
}
