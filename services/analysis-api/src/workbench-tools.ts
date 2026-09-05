import type { ConversationRepository, PortfolioRepository, TrackingRepository } from '@vibe-invest/product-dao'
import type { ConversationToolExecutor } from './model.js'
import type { createWorkbench } from './workbench.js'
import type { createResearchLibrary } from './research-library.js'
import { createPortfolio, isValidSymbol, normalizeSymbol } from './portfolio.js'
import { workbenchToolNames } from './tool-definitions/workbench.js'
import { selectFreeResearchToolNames } from './free-research-tool-pack.js'

type Options = {
  library?: ReturnType<typeof createResearchLibrary>
  workbench?: ReturnType<typeof createWorkbench>
  portfolio: PortfolioRepository
  tracking?: TrackingRepository
  conversations: ConversationRepository
}
export function createWorkbenchToolExecutor(options: Options, context: {
  threadId: string; userMessage: string; executionId: string; scopeMessages: string[]; symbols: string[]; knownFacts: Map<string, { id: string; [key: string]: unknown }>
}, fallback: ConversationToolExecutor): ConversationToolExecutor {
  return async (name, params, signal, onStart) => {
    if (!workbenchToolNames.has(name)) return fallback(name, params, signal, onStart)
    await onStart()
    try {
      signal.throwIfAborted()
      const thread = await options.conversations.get(context.threadId)
      if (!thread || thread.parentThreadId) throw new Error('tool_not_available')
      const input = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
      const allowed = selectFreeResearchToolNames(context.userMessage, context.scopeMessages)
      if (!allowed.includes(name)) throw new Error('tool_not_available')
      const operationId = typeof input.operationId === 'string' ? `${context.threadId}:${input.operationId}` : input.operationId
      const workbench = options.workbench
      const library = options.library
      const id = typeof input.id === 'string' ? input.id : ''
      let result: Record<string, unknown>
      if (name === 'search_research_library' && library) result = await library.search({
        q: typeof input.query === 'string' ? input.query : undefined,
        symbol: typeof input.symbol === 'string' ? input.symbol : undefined,
        offset: typeof input.offset === 'number' ? input.offset : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      })
      else if (name === 'read_research_record' && library) {
        const record = await library.read(id, Number(input.offset ?? 0), Number(input.limit ?? 30))
        if (!record) throw new Error('research_record_not_found')
        await library.recordSource(context.threadId, record, context.executionId)
        if (record.record.symbol && !context.symbols.includes(record.record.symbol)) context.symbols.push(record.record.symbol)
        for (const fact of record.facts) {
          if (typeof fact.id === 'string') context.knownFacts.set(fact.id, { ...fact, id: fact.id })
        }
        result = record
      } else if (name === 'get_workspace_context') {
        const [portfolio, watchlist, stances, pages] = await Promise.all([
          createPortfolio(options.portfolio).overview({}), options.tracking?.listWatchlist() ?? [],
          workbench?.listStances() ?? [], workbench?.listPages() ?? [],
        ])
        result = { portfolio, watchlist, stances, pages, gaps: ['持仓为当前账本记录，此工具未刷新市场行情'] }
      } else if (name === 'save_research_stance' && workbench) {
        signal.throwIfAborted()
        result = { stance: await workbench.saveStance({ ...input, operationId, sourceThreadId: context.threadId }, context.executionId) }
      } else if (name === 'read_workbench_page' && workbench) {
        const page = await workbench.getPage(id)
        if (!page) throw new Error('workbench_page_not_found')
        result = page
      } else if (name === 'save_workbench_page' && workbench) {
        signal.throwIfAborted()
        const page = await workbench.savePage({ ...input, operationId }, context.executionId)
        result = { page, href: `/workbench/${encodeURIComponent(page.id)}` }
      } else if (name === 'restore_workbench_page' && workbench) {
        signal.throwIfAborted()
        const page = await workbench.restorePage({ ...input, operationId }, context.executionId)
        result = { page, href: `/workbench/${encodeURIComponent(page.id)}` }
      } else if (name === 'record_portfolio_trade') {
        const symbol = normalizeSymbol(typeof input.symbol === 'string' ? input.symbol : '')
        const { quantity, price, side, operationId } = input
        if (!isValidSymbol(symbol) || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0
          || typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity * price)
          || !['buy', 'sell'].includes(String(side)) || typeof operationId !== 'string' || !operationId.trim() || operationId.length > 150) throw new Error('invalid_portfolio_trade')
        signal.throwIfAborted()
        const key = `${context.threadId}:${operationId}`
        const trade = side === 'buy'
          ? await options.portfolio.recordBuy(symbol, quantity, price, '', key, context.executionId)
          : await options.portfolio.recordSell(symbol, quantity, price, '', key, context.executionId)
        if (!trade) throw new Error(side === 'buy' ? 'insufficient_cash' : 'insufficient_position')
        result = { ...trade, href: '/portfolio' }
      } else if (name === 'set_watchlist_item' && options.tracking) {
        const symbol = normalizeSymbol(typeof input.symbol === 'string' ? input.symbol : '')
        if (!isValidSymbol(symbol) || typeof input.enabled !== 'boolean'
          || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500))) throw new Error('invalid_watchlist_item')
        signal.throwIfAborted()
        const item = await options.tracking.setWatchlistItem(symbol, {
          enabled: input.enabled, ...(typeof input.note === 'string' ? { note: input.note } : {}),
        }, context.executionId)
        result = { item, symbol, enabled: input.enabled }
      } else throw new Error('tool_not_available')
      return { result, isError: false }
    } catch (error) {
      return { result: { error: error instanceof Error ? error.message : 'workbench_operation_failed' }, isError: true }
    }
  }
}
