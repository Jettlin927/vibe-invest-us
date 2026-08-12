import type {
  PortfolioRepository,
  ProductEquitySnapshot,
  ProductPosition,
} from '@vibe-invest/product-dao'

export function createTestProductDatabase() {
  const positions = new Map<string, ProductPosition>()
  const snapshots = new Map<string, ProductEquitySnapshot>()
  let cash = 0

  const portfolioRepository: PortfolioRepository = {
    async list() { return [...positions.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)) },
    async save(position) { positions.set(position.symbol, { ...position }); return position },
    async remove(symbol) { positions.delete(symbol) },
    async cash() { return cash },
    async setCash(value) { cash = value; return value },
    async reduce(symbol, quantity, price) {
      const position = positions.get(symbol)
      if (!position || quantity > position.quantity) return null
      const remaining = position.quantity - quantity
      cash += quantity * price
      if (remaining === 0) positions.delete(symbol)
      else positions.set(symbol, { ...position, quantity: remaining })
      return {
        position: remaining === 0 ? null : { ...position, quantity: remaining },
        cash,
        proceeds: quantity * price,
        realizedProfitLoss: (price - position.averageCost) * quantity,
      }
    },
    async saveSnapshot(snapshot) {
      const current = snapshots.get(snapshot.marketDay)
      if (current?.afterClose && !snapshot.afterClose) return false
      snapshots.set(snapshot.marketDay, { ...snapshot })
      return true
    },
    async listSnapshots(limit) {
      return [...snapshots.values()]
        .sort((left, right) => right.marketDay.localeCompare(left.marketDay))
        .slice(0, limit)
    },
  }

  return {
    productDatabase: {
      checkSchema: async () => ({ status: 'ok' as const, version: 1 }),
      close: async () => {},
    },
    portfolioRepository,
  }
}
