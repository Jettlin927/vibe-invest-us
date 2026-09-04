export type ToolHandlerOwner = 'research_capability' | 'conversation_runtime'

const handlerNames: Record<ToolHandlerOwner, ReadonlySet<string>> = {
  research_capability: new Set([
    'create_research_report', 'search_evidence', 'read_evidence',
    'get_company_dossier', 'get_market_structure', 'get_research_context',
    'compare_securities', 'get_portfolio_exposure', 'search_web_evidence',
  ]),
  conversation_runtime: new Set(['delegate_research', 'collect_research']),
}

export function hasRegisteredToolHandler(owner: ToolHandlerOwner, name: string) {
  return handlerNames[owner].has(name)
}
