export type ProductPosition = {
  symbol: string
  quantity: number
  averageCost: number
}

export type PortfolioEvent = {
  id: string
  kind: 'buy' | 'sell' | 'cash_adjust' | 'reconcile'
  symbol: string | null
  quantity: number | null
  price: number | null
  amount: number | null
  realizedProfitLoss: number | null
  note: string
  createdAt: string
}

export type ProductEquitySnapshot = {
  marketDay: string
  totalEquity: number
  totalMarketValue: number
  cash: number
  holdingsCount: number
  pricedCount: number
  observedAt: string
  afterClose: boolean
}

export type QuoteFreshness = {
  /** 本批行情里最早的观测时间；为 null 表示上游没有给出观测时间。 */
  observedAt: string | null
  sources: string[]
  /** 这批结果实际取得的时间；cached 为真时即缓存写入时间。 */
  fetchedAt: string
  cached: boolean
}

export type PortfolioOverview = {
  cash: number
  totalCost: number
  totalMarketValue: number | null
  totalEquity: number | null
  totalUnrealizedProfitLoss: number | null
  totalUnrealizedReturn: number | null
  pricedPositionCount: number
  unpricedPositionCount: number
  positions: Array<ProductPosition & {
    costAmount: number
    marketPrice: number | null
    /** 行情相对上一交易日收盘价的每股涨跌额和涨跌幅。 */
    dailyChange: number | null
    dailyReturn: number | null
    marketValue: number | null
    unrealizedProfitLoss: number | null
    unrealizedReturn: number | null
    portfolioWeight: number | null
  }>
  /** 只在确实取到行情元数据时出现；/api/portfolio/stored 不带此字段。 */
  quotes?: QuoteFreshness
}

export type PortfolioEquitySnapshot = {
  marketDay: string
  totalEquity: number
  totalMarketValue: number
  cash: number
  holdingsCount: number
  pricedCount: number
  observedAt: string
  afterClose: boolean
  dailyChange: number | null
  dailyReturn: number | null
}

export function calculatePortfolioOverview(positions: ProductPosition[], cash: number, marketPrices: Record<string, number>, previousCloses: Record<string, number | null> = {}): PortfolioOverview {
  const values = positions.map((position) => {
    const observedPrice = marketPrices[position.symbol]
    const marketPrice = Number.isFinite(observedPrice) && observedPrice! >= 0 ? observedPrice! : null
    const observedClose = previousCloses[position.symbol]
    const previousClose = typeof observedClose === 'number' && Number.isFinite(observedClose) && observedClose > 0 ? observedClose : null
    const dailyChange = marketPrice === null || previousClose === null ? null : marketPrice - previousClose
    const costAmount = position.quantity * position.averageCost
    const marketValue = marketPrice === null ? null : position.quantity * marketPrice
    const unrealizedProfitLoss = marketValue === null ? null : marketValue - costAmount
    return {
      ...position, costAmount, marketPrice, marketValue, unrealizedProfitLoss,
      dailyChange,
      dailyReturn: dailyChange === null ? null : dailyChange / previousClose!,
      unrealizedReturn: unrealizedProfitLoss === null || costAmount === 0 ? null : unrealizedProfitLoss / costAmount,
      portfolioWeight: null,
    }
  })
  const priced = values.filter((position) => position.marketValue !== null)
  const totalCost = values.reduce((total, position) => total + position.costAmount, 0)
  const pricedCost = priced.reduce((total, position) => total + position.costAmount, 0)
  const pricedMarketValue = priced.reduce((total, position) => total + position.marketValue!, 0)
  const complete = priced.length === values.length
  const totalMarketValue = complete ? pricedMarketValue : null
  const totalEquity = complete ? pricedMarketValue + cash : null
  const totalUnrealizedProfitLoss = complete
    ? priced.reduce((total, position) => total + position.unrealizedProfitLoss!, 0)
    : null
  return {
    cash, totalCost, totalMarketValue, totalEquity, totalUnrealizedProfitLoss,
    totalUnrealizedReturn: totalUnrealizedProfitLoss === null || pricedCost === 0 ? null : totalUnrealizedProfitLoss / pricedCost,
    pricedPositionCount: priced.length,
    unpricedPositionCount: values.length - priced.length,
    positions: values.map((position) => ({
      ...position,
      portfolioWeight: totalEquity && position.marketValue !== null ? position.marketValue / totalEquity : null,
    })),
  }
}

export function calculatePortfolioContext(positions: ProductPosition[], symbol: string, marketPrices: Record<string, number>) {
  const valuedPositions = positions.flatMap((position) => {
    const marketPrice = marketPrices[position.symbol]
    if (!Number.isFinite(marketPrice) || marketPrice! < 0) return []
    return [{ ...position, marketPrice: marketPrice!, marketValue: position.quantity * marketPrice! }]
  })
  const totalMarketValue = valuedPositions.reduce((total, position) => total + position.marketValue, 0)
  const unpricedPositionCount = positions.length - valuedPositions.length
  const weights = valuedPositions
    .map((position) => totalMarketValue === 0 ? 0 : position.marketValue / totalMarketValue)
    .sort((left, right) => right - left)
  const current = valuedPositions.find((position) => position.symbol === symbol)
  return {
    position: current ? {
      symbol: current.symbol,
      quantity: current.quantity,
      averageCost: current.averageCost,
      marketPrice: current.marketPrice,
      marketValue: current.marketValue,
      unrealizedProfitLoss: current.marketValue - current.quantity * current.averageCost,
      portfolioWeight: unpricedPositionCount > 0 || totalMarketValue === 0
        ? null
        : current.marketValue / totalMarketValue,
    } : null,
    portfolio: {
      totalMarketValue: unpricedPositionCount > 0 ? null : totalMarketValue,
      largestPositionWeight: unpricedPositionCount > 0 ? null : weights[0] ?? 0,
      topThreeWeight: unpricedPositionCount > 0
        ? null
        : weights.slice(0, 3).reduce((total, weight) => total + weight, 0),
      positionCount: positions.length,
      pricedPositionCount: valuedPositions.length,
      unpricedPositionCount,
    },
  }
}

export function marketTime(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    marketDay: `${read('year')}-${read('month')}-${read('day')}`,
    afterClose: Number(read('hour')) * 60 + Number(read('minute')) >= 16 * 60,
  }
}

export function normalizeSymbol(value: string) {
  return value.trim().toUpperCase()
}

export function isValidSymbol(symbol: string) {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)
}

export function calculateBuy(position: ProductPosition | null, cash: number, symbol: string, quantity: number, price: number) {
  const spent = quantity * price
  if (spent > cash) return null
  const nextQuantity = (position?.quantity ?? 0) + quantity
  const averageCost = position
    ? (position.quantity * position.averageCost + spent) / nextQuantity
    : price
  return { position: { symbol, quantity: nextQuantity, averageCost }, cash: cash - spent, spent }
}

export function calculateSell(position: ProductPosition | null, cash: number, quantity: number, price: number) {
  if (!position || quantity > position.quantity) return null
  const remaining = position.quantity - quantity
  const proceeds = quantity * price
  return {
    position: remaining === 0 ? null : { ...position, quantity: remaining },
    cash: cash + proceeds, proceeds,
    realizedProfitLoss: (price - position.averageCost) * quantity,
  }
}
