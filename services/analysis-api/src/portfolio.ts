import type { PortfolioRepository, ProductPosition } from '@vibe-invest/product-dao'

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
    marketValue: number | null
    unrealizedProfitLoss: number | null
    unrealizedReturn: number | null
    portfolioWeight: number | null
  }>
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

export function createPortfolio(repository: PortfolioRepository) {
  async function overview(marketPrices: Record<string, number>): Promise<PortfolioOverview> {
    const [positions, cash] = await Promise.all([repository.list(), repository.cash()])
    const values = positions.map((position) => {
      const observedPrice = marketPrices[position.symbol]
      const marketPrice = Number.isFinite(observedPrice) && observedPrice! >= 0 ? observedPrice! : null
      const costAmount = position.quantity * position.averageCost
      const marketValue = marketPrice === null ? null : position.quantity * marketPrice
      const unrealizedProfitLoss = marketValue === null ? null : marketValue - costAmount
      return {
        ...position, costAmount, marketPrice, marketValue, unrealizedProfitLoss,
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

  return {
    list: () => repository.list(),
    recordBuy: (symbol: string, quantity: number, price: number) => repository.recordBuy(symbol, quantity, price),
    recordSell: (symbol: string, quantity: number, price: number) => repository.recordSell(symbol, quantity, price),
    adjustCash: (cash: number) => repository.recordCashAdjustment(cash),
    reconcile: (position: ProductPosition) => repository.recordReconcile(
      position.symbol, position.quantity, position.averageCost,
    ),
    remove: (symbol: string) => repository.recordReconcile(symbol, 0, 0),
    listEvents: (limit?: number) => repository.listEvents(limit),
    overview,
    async recordSnapshot(value: PortfolioOverview, observedAt = new Date()) {
      if (value.totalEquity === null || value.totalMarketValue === null || value.positions.length === 0) return false
      const { marketDay, afterClose } = marketTime(observedAt)
      return repository.saveSnapshot({
        marketDay,
        totalEquity: value.totalEquity,
        totalMarketValue: value.totalMarketValue,
        cash: value.cash,
        holdingsCount: value.positions.length,
        pricedCount: value.pricedPositionCount,
        observedAt: observedAt.toISOString(),
        afterClose,
      })
    },
    async history(limit = 30): Promise<PortfolioEquitySnapshot[]> {
      const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 365)) : 30
      const rows = (await repository.listSnapshots(safeLimit)).reverse()
      return rows.map((row, index) => {
        const previous = rows[index - 1]
        const dailyChange = previous ? row.totalEquity - previous.totalEquity : null
        return {
          ...row,
          dailyChange,
          dailyReturn: previous && previous.totalEquity !== 0 ? dailyChange! / previous.totalEquity : null,
        }
      }).reverse()
    },
    async context(symbol: string, marketPrices: Record<string, number>) {
      const positions = await repository.list()
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
    },
  }
}

function marketTime(value: Date) {
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
