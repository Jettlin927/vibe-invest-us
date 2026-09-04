export function selectFreeResearchToolNames(
  userMessage: string, scopeMessages: string[] = [],
): string[] {
  const requested: string[] = []
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
