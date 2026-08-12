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
    async findActive(symbol) {
      return [...analyses.values()]
        .filter((record) => record.symbol === symbol && ['queued', 'running'].includes(record.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]?.id ?? null
    },
    async create(record) {
      analyses.set(record.id, { ...record, snapshot: null, report: null, error: null, starred: false, note: '' })
    },
    async nextQueued() {
      return [...analyses.values()].filter((record) => record.status === 'queued')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]?.id ?? null
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
      checkSchema: async () => ({ status: 'ok' as const, version: 3 }),
      close: async () => {},
    },
    portfolioRepository,
    analysisRepository,
  }
}
