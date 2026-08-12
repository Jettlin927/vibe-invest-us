import type {
  AnalysisRecord, AnalysisRepository, PortfolioRepository,
  ProductEquitySnapshot,
  ProductPosition,
} from '@vibe-invest/product-dao'

export function createTestProductDatabase() {
  const positions = new Map<string, ProductPosition>()
  const snapshots = new Map<string, ProductEquitySnapshot>()
  let cash = 0
  const analyses = new Map<string, AnalysisRecord>()
  const facts = new Map<string, Record<string, unknown>>()
  const analysisFacts = new Map<string, Set<string>>()
  const traces = new Map<string, unknown[]>()

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
    async migrationVerificationState() {
      return {
        positions: [...positions.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)).map((position) => ({
          symbol: position.symbol, quantity: String(position.quantity), averageCost: String(position.averageCost),
        })),
        cash: String(cash),
        snapshots: [...snapshots.values()].sort((left, right) => left.marketDay.localeCompare(right.marketDay)).map((snapshot) => ({
          marketDay: snapshot.marketDay, totalEquity: String(snapshot.totalEquity),
          totalMarketValue: String(snapshot.totalMarketValue), cash: String(snapshot.cash),
        })),
      }
    },
  }

  const analysisRepository: AnalysisRepository = {
    async interruptRunning(updatedAt) {
      for (const [id, record] of analyses) {
        if (['queued', 'running'].includes(record.status)) {
          analyses.set(id, { ...record, status: 'interrupted', updatedAt })
        }
      }
    },
    async saveFact(analysisId, fact) {
      facts.set(fact.id, fact)
      const ids = analysisFacts.get(analysisId) ?? new Set()
      ids.add(fact.id)
      analysisFacts.set(analysisId, ids)
    },
    async appendTrace(analysisId, payload) {
      traces.set(analysisId, [...(traces.get(analysisId) ?? []), payload])
    },
    async setStatus(id, status, updatedAt, extra = {}) {
      const record = analyses.get(id)
      if (!record) return
      analyses.set(id, {
        ...record, status, updatedAt,
        report: extra.report ?? record.report,
        snapshot: extra.snapshot ?? record.snapshot,
        error: extra.error ?? record.error,
      })
    },
    async get(id) { return analyses.get(id) ?? null },
    async createOrReturn(record) {
      const existing = [...analyses.values()]
        .filter((candidate) => candidate.symbol === record.symbol && ['queued', 'running'].includes(candidate.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
      if (existing) return { analysisId: existing.id, created: false }
      analyses.set(record.id, { ...record, snapshot: null, report: null, error: null, starred: false, note: '' })
      return { analysisId: record.id, created: true }
    },
    async claimNextQueued(updatedAt) {
      const record = [...analyses.values()].filter((candidate) => candidate.status === 'queued')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
      if (!record) return null
      analyses.set(record.id, { ...record, status: 'running', updatedAt })
      return record.id
    },
    async saveSnapshot(id, snapshot) {
      const record = analyses.get(id)
      if (record) analyses.set(id, { ...record, snapshot })
    },
    async research(id) {
      const record = analyses.get(id)
      if (!record) return null
      return {
        ...record,
        facts: [...(analysisFacts.get(id) ?? [])].flatMap((factId) => facts.get(factId) ?? []),
        trace: traces.get(id) ?? [],
      }
    },
    async listResearch(symbol) {
      return [...analyses.values()].filter((record) => (
        ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(record.status)
        && (!symbol || record.symbol === symbol.toUpperCase())
      )).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },
    async updateResearch(id, values, updatedAt) {
      const record = analyses.get(id)
      if (!record) return null
      const updated = { ...record, ...values, updatedAt }
      analyses.set(id, updated)
      return updated
    },
    async removeResearch(id) {
      if (!analyses.delete(id)) return false
      analysisFacts.delete(id)
      traces.delete(id)
      const referenced = new Set([...analysisFacts.values()].flatMap((ids) => [...ids]))
      for (const factId of facts.keys()) if (!referenced.has(factId)) facts.delete(factId)
      return true
    },
  }

  return {
    productDatabase: {
      checkSchema: async () => ({ status: 'ok' as const, version: 4 }),
      close: async () => {},
    },
    portfolioRepository,
    analysisRepository,
  }
}
