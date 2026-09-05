export function selectFreeResearchToolNames(
  userMessage: string, scopeMessages: string[] = [],
): string[] {
  const requested: string[] = []
  // scopeMessages 按最近用户消息优先排列；只延续紧邻操作，避免历史写入意图泄漏到新话题。
  const previous = scopeMessages[0] ?? ''
  const writeDenied = /(?:不要|不用|无需|别|暂不|先不).{0,12}(?:保存|记录|创建|修改|恢复|加入|移除|移到|放到|调整|删除|添加)/
  const stanceObject = /(?:立场|态度|观点|条件|决定)/
  const pageObject = /(?:页面|看板|决策页|组件|布局)/
  const tradeObject = /(?:成交|买入|卖出|交易)/
  const watchlistObject = /自选/
  const deniedFor = (message: string, object: RegExp) => message.split(/[，,。；;！？!?\n]|但是|然后|但/).some((clause) => (
    writeDenied.test(clause) && (object.test(clause)
      || ![stanceObject, pageObject, tradeObject, watchlistObject].some((target) => target.test(clause)))
  ))
  const speculative = /(?:考虑|假设|如果|计划|打算|要不要)/
  const tradeRequested = /(?:已|刚刚|刚才).{0,8}(?:买|卖)|记录.{0,8}(?:成交|买入|卖出)/
  const pageMentioned = /(?:页面|看板|决策页)/
  const pageEdit = /(?:组件|布局).{0,16}(?:移到|移至|放到|调整|删除|添加)|(?:调整|删除|添加).{0,16}组件/
  const continuePage = pageMentioned.test(previous) && !deniedFor(previous, pageObject) && pageEdit.test(userMessage)
  const continueTrade = tradeRequested.test(previous) && !deniedFor(previous, tradeObject) && !speculative.test(previous)
    && /^\s*\d+(?:\.\d+)?\s*股[，,\s]*(?:成交价|价格|每股)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:美元|元)?[。！!]?\s*$/.test(userMessage)

  if (/(?:研究记录|研究过|报告中|这份报告|已有研究|讨论|之前|以前|历史|态度|共识|分歧|history)/i.test(userMessage)) {
    requested.push('search_research_library', 'read_research_record')
  }
  if (/(?:持仓|组合|自选|立场|态度|页面|看板|工作台)/.test(userMessage)) requested.push('get_workspace_context')
  if (/(?:继续|补查|基于).{0,24}(?:研究|报告)|(?:研究|报告).{0,24}(?:继续|补查)/.test(userMessage)) {
    requested.push('search_research_library', 'read_research_record', 'get_research_context', 'get_company_dossier', 'get_market_structure', 'search_evidence', 'read_evidence')
  }
  if (!deniedFor(userMessage, stanceObject)
    && /(?:保存|记录|记住|更新).{0,20}(?:立场|态度|观点|条件|决定)/.test(userMessage)) requested.push('save_research_stance')
  if (!deniedFor(userMessage, watchlistObject)
    && /(?:加入|添加|移除|删除|取消).{0,20}自选/.test(userMessage)) requested.push('set_watchlist_item')
  if (!deniedFor(userMessage, tradeObject) && (tradeRequested.test(userMessage) || continueTrade)
    && !speculative.test(userMessage)) requested.push('record_portfolio_trade')
  if (!deniedFor(userMessage, pageObject)) {
    if (/(?:创建|新增|做|保存|修改|更新|调整).{0,20}(?:页面|看板|决策页)/.test(userMessage) || continuePage) requested.push('save_workbench_page')
    if (/(?:恢复|回退).{0,20}(?:页面|看板|布局)/.test(userMessage)) requested.push('restore_workbench_page')
  }
  if (/(?:页面|看板|决策页|布局)/.test(userMessage) || continuePage) requested.push('read_workbench_page')
  if (/(?:技术面|技术分析|技术结构|K线|k线|蜡烛图|均线|成交量|量价|支撑|阻力|趋势线|走势|形态|突破|跌破|动量|回撤|波动率|MACD|RSI|KDJ|布林|technical|candlestick|price chart)/i.test(userMessage)) {
    requested.push('get_market_structure')
  }
  if (/(?:基本面|财报|财务|营收|收入|利润|毛利|净利|现金流|资产负债|估值|市盈率|市净率|\bPE\b|\bPB\b|EPS|EBITDA|DCF|10-K|10-Q|8-K|filing|earnings|valuation|fundamental)/i.test(userMessage)) {
    requested.push('get_company_dossier')
  }
  if (/(?:消息面|新闻|消息|公司事件|事件|公告|舆情|催化|公司动态|headline|news|event|announcement)/i.test(userMessage)) {
    requested.push('search_evidence', 'read_evidence')
  }
  const reportDenied = /(?:不要|不用|无需|别|不需要|暂不|先不).{0,12}(?:报告|研报|report)/i
    .test(userMessage)
  const reportExplained = /(?:(?:解释|说明|介绍|什么是|是什么意思|如何理解|怎么理解).{0,16}(?:报告|研报|report)|(?:报告|研报|report).{0,16}(?:是什么|是什么意思|怎么理解))/i
    .test(userMessage)
  const reportRequested = /(?:(?:生成|创建|写|撰写|整理|保存|输出|形成|制作|更新|给我|做).{0,12}(?:报告|研报)|(?:generate|create|write|save|update).{0,16}report)/i
    .test(userMessage)
  if (reportRequested && !reportDenied && !reportExplained) requested.push('create_research_report')
  const agentDenied = /(?:不要|不用|无需|别|不需要|暂不|先不).{0,12}(?:子\s*Agent|子代理|sub-?agent)/i
    .test(userMessage)
  const delegateRequested = /(?:派|让|请|创建|启动|调用|委派|安排).{0,12}(?:子\s*Agent|子代理|sub-?agent)/i
    .test(userMessage)
  const collectRequested = /(?:等待|读取|查看|汇总|收集|停止|终止|取消).{0,12}(?:子\s*Agent|子代理|sub-?agent)/i
    .test(userMessage)
  if (delegateRequested && !agentDenied) {
    requested.push('delegate_research', 'collect_research')
  } else if (collectRequested && !agentDenied) {
    requested.push('collect_research')
  }
  if (/(?:比较|对比|横向|相比|孰优|哪个更|compare|versus|\bvs\.?\b)/i.test(userMessage)) {
    requested.push('compare_securities')
  }
  if (/(?:我的持仓|当前持仓|组合|仓位|集中度|风险暴露|portfolio|exposure|position weight)/i.test(userMessage)) {
    requested.push('get_portfolio_exposure')
  }
  const hasSymbol = extractFreeResearchSymbols([userMessage, ...scopeMessages]).length > 0
  const nonDataTools = new Set([
    'create_research_report', 'delegate_research', 'collect_research',
    'search_research_library', 'read_research_record', 'get_workspace_context',
    'save_research_stance', 'set_watchlist_item', 'record_portfolio_trade',
    'save_workbench_page', 'read_workbench_page', 'restore_workbench_page',
  ])
  if (hasSymbol && !requested.some((name) => !nonDataTools.has(name))) {
    requested.push('get_research_context')
  }
  return requested
}

export function extractFreeResearchSymbols(messages: string[]) {
  return [...new Set(messages.flatMap((message) => tickerTokens(message)))]
}

function tickerTokens(message: string) {
  const nonSymbols = new Set([
    'AI', 'ADR', 'CEO', 'CPI', 'DCF', 'EBITDA', 'EPS', 'ETF', 'FOMC', 'GDP',
    'KDJ', 'MA', 'MACD', 'PB', 'PCE', 'PE', 'RSI', 'SEC', 'TTM', 'USD',
    'API', 'CLI', 'CSS', 'HTML', 'HTTP', 'HTTPS', 'JSON', 'MCP', 'SDK', 'SQL', 'SSE', 'URL',
  ])
  const tokens = new Set<string>()
  const hasTickerContext = /(?:股票|标的|代码|ticker|分析|研究|最近|怎么样|走势|形态|K线|k线|财报|估值|新闻|公司)/i
    .test(message)
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  for (const match of message.matchAll(/\b[A-Z]{1,5}\b/g)) {
    const token = match[0]
    const index = match.index
    const before = Array.from(message.slice(0, index)).at(-1) ?? ''
    const after = Array.from(message.slice(index + token.length))[0] ?? ''
    if (!hasTickerContext && (cjk.test(before) || cjk.test(after))) continue
    if (!nonSymbols.has(token)) tokens.add(token)
  }
  for (const match of message.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const token = match[1]!.toUpperCase()
    if (!nonSymbols.has(token)) tokens.add(token)
  }
  if (hasTickerContext) {
    for (const token of message.match(/\b[a-z]{2,5}\b/g) ?? []) {
      const normalized = token.toUpperCase()
      if (!nonSymbols.has(normalized)) tokens.add(normalized)
    }
  }
  return [...tokens]
}
