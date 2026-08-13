export type RegisteredToolHandler = (
  params: unknown,
  context: Record<string, ((params?: unknown) => Promise<unknown>) | undefined>,
) => Promise<unknown>

export const registeredToolHandlers: Record<string, RegisteredToolHandler> = {
  fetch_financial_context: async (_params, context) => context.loadFinancialContext?.(),
  analyze_financials: async (_params, context) => context.runFinancialSpecialist?.(),
  submit_analysis_report: async (params, context) => context.submitAnalysisReport?.(params),
  search_news_by_keyword: async (params, context) => context.searchNews?.(params),
  get_technical_indicators: async (params, context) => context.fetchTechnicalIndicators?.(params),
}
