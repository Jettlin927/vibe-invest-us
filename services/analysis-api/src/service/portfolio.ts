import type { PortfolioRepository } from '@vibe-invest/db'
import { calculatePortfolioOverview, calculatePortfolioContext, marketTime, type ProductPosition, type PortfolioOverview, type PortfolioEquitySnapshot } from '@vibe-invest/domain/portfolio'
export { isValidSymbol, normalizeSymbol } from '@vibe-invest/domain/portfolio'
export type { PortfolioOverview, PortfolioEquitySnapshot, QuoteFreshness } from '@vibe-invest/domain/portfolio'

export function createPortfolio(repository: PortfolioRepository) {
  async function overview(marketPrices: Record<string, number>, previousCloses: Record<string, number | null> = {}): Promise<PortfolioOverview> {
    const [positions, cash] = await Promise.all([repository.list(), repository.cash()])
    return calculatePortfolioOverview(positions, cash, marketPrices, previousCloses)
  }

  return {
    list: () => repository.list(),
    recordBuy: (symbol: string, quantity: number, price: number, note?: string, operationId?: string) => repository.recordBuy(symbol, quantity, price, note, operationId),
    recordSell: (symbol: string, quantity: number, price: number, note?: string, operationId?: string) => repository.recordSell(symbol, quantity, price, note, operationId),
    adjustCash: (cash: number, note?: string, operationId?: string) => repository.recordCashAdjustment(cash, note, operationId),
    reconcile: (position: ProductPosition, note?: string, operationId?: string) => repository.recordReconcile(
      position.symbol, position.quantity, position.averageCost, note, operationId,
    ),
    remove: (symbol: string) => repository.recordReconcile(symbol, 0, 0),
    listEvents: (limit?: number) => repository.listEvents(limit),
    overview,
    migrationVerificationState: () => repository.migrationVerificationState(),
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
      return calculatePortfolioContext(await repository.list(), symbol, marketPrices)
    },
  }
}
