import type {
  AgentEvent, AgentEventRepository, AgentSession, AnalysisRecord, AnalysisRepository, PortfolioRepository,
  ProductEquitySnapshot, RuntimeSettingsRepository,
  ProductPosition,
} from '@vibe-invest/product-dao'
import { defaultRuntimeSettings, parseRuntimeSettingsUpdate } from '@vibe-invest/contracts'

export function createTestProductDatabase() {
  const positions = new Map<string, ProductPosition>()
  const snapshots = new Map<string, ProductEquitySnapshot>()
  let cash = 0
  const analyses = new Map<string, AnalysisRecord>()
  const facts = new Map<string, Record<string, unknown>>()
  const analysisFacts = new Map<string, Set<string>>()
  const traces = new Map<string, unknown[]>()
  const agentSessions = new Map<string, AgentSession>()
  const agentEvents = new Map<string, AgentEvent[]>()
  let nextSettingsRevisionId = 1
  const runtimeSettingsRevisions = [{
    id: nextSettingsRevisionId, values: { ...defaultRuntimeSettings }, createdAt: '2026-08-13T00:00:00.000Z',
  }]
  const executionSettingsSnapshots = new Map<string, Awaited<ReturnType<RuntimeSettingsRepository['freezeExecution']>>>()

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

  const agentEventRepository: AgentEventRepository = {
    async createResearch(input) {
      const existing = [...analyses.values()]
        .find((record) => record.symbol === input.symbol && ['queued', 'running'].includes(record.status))
      if (existing) {
        const session = [...agentSessions.values()].find((candidate) => (
          candidate.analysisId === existing.id && candidate.isPrimary
        ))
        const event = session ? agentEvents.get(session.id)?.[0] : undefined
        if (!session || !event) throw new Error('agent_session_not_found')
        return {
          analysisId: existing.id, sessionId: session.id,
          sequence: event.sequence, created: false, event,
        }
      }
      const event = {
        sessionId: input.sessionId, sequence: 1, operationId: input.operationId,
        payload: input.event, createdAt: input.createdAt,
      }
      agentSessions.set(input.sessionId, {
        id: input.sessionId, analysisId: input.analysisId, status: input.status, isPrimary: true,
        executionId: input.executionId,
        latestSequence: 1, createdAt: input.createdAt, updatedAt: input.createdAt,
      })
      agentEvents.set(input.sessionId, [event])
      executionSettingsSnapshots.set(input.executionId, {
        executionId: input.executionId,
        id: runtimeSettingsRevisions.at(-1)!.id,
        values: { ...runtimeSettingsRevisions.at(-1)!.values },
        createdAt: input.createdAt,
      })
      analyses.set(input.analysisId, {
        id: input.analysisId, symbol: input.symbol, status: input.status,
        createdAt: input.createdAt, updatedAt: input.createdAt,
        snapshot: null, report: null, error: null, starred: false, note: '',
      })
      return {
        analysisId: input.analysisId, sessionId: input.sessionId,
        sequence: 1, created: true, event,
      }
    },
    async createSession(input) {
      if (!analyses.has(input.analysisId)) throw new Error('analysis_not_found')
      const event = {
        sessionId: input.id, sequence: 1, operationId: input.operationId,
        payload: input.event, createdAt: input.createdAt,
      }
      agentSessions.set(input.id, {
        id: input.id, analysisId: input.analysisId, status: input.status, isPrimary: false,
        executionId: input.executionId,
        latestSequence: 1, createdAt: input.createdAt, updatedAt: input.createdAt,
      })
      agentEvents.set(input.id, [event])
      const current = runtimeSettingsRevisions.at(-1)!
      executionSettingsSnapshots.set(input.executionId, {
        executionId: input.executionId,
        id: current.id,
        values: { ...current.values },
        createdAt: input.createdAt,
      })
      return { sequence: 1, created: true, event }
    },
    async append(input) {
      const events = agentEvents.get(input.sessionId) ?? []
      const existing = events.find(({ operationId }) => operationId === input.operationId)
      if (existing) return { sequence: existing.sequence, created: false, event: existing }
      const session = agentSessions.get(input.sessionId)
      if (!session) throw new Error('agent_session_not_found')
      const event = {
        sessionId: input.sessionId, sequence: session.latestSequence + 1,
        operationId: input.operationId, payload: input.event, createdAt: input.createdAt,
      }
      agentEvents.set(input.sessionId, [...events, event])
      agentSessions.set(input.sessionId, {
        ...session, status: input.projection?.status ?? session.status,
        latestSequence: event.sequence, updatedAt: input.createdAt,
      })
      if (input.projection) {
        const analysisId = session.analysisId
        for (const fact of input.projection.facts ?? []) {
          facts.set(fact.id, fact)
          const ids = analysisFacts.get(analysisId) ?? new Set()
          ids.add(fact.id)
          analysisFacts.set(analysisId, ids)
        }
        const record = analyses.get(analysisId)
        if (record && session.isPrimary) analyses.set(analysisId, {
          ...record, status: input.projection.status ?? record.status, updatedAt: input.createdAt,
          report: input.projection.report ?? record.report,
          snapshot: input.projection.snapshot ?? record.snapshot,
          error: input.projection.error ?? record.error,
        })
      }
      return { sequence: event.sequence, created: true, event }
    },
    async list(sessionId, afterSequence) {
      return (agentEvents.get(sessionId) ?? []).filter(({ sequence }) => sequence > afterSequence)
    },
    async getSession(id) { return agentSessions.get(id) ?? null },
    async findPrimarySession(analysisId) {
      return [...agentSessions.values()].find((session) => (
        session.analysisId === analysisId && session.isPrimary
      )) ?? null
    },
    async listSessions(analysisId) {
      return [...agentSessions.values()].filter((session) => session.analysisId === analysisId)
        .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)
          || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    },
    async interruptActiveSessions(createdAt) {
      const interrupted: AgentEvent[] = []
      for (const [id, session] of [...agentSessions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (!['queued', 'running'].includes(session.status)) continue
        const sequence = session.latestSequence + 1
        const operationId = `startup:interrupt:${id}:${sequence}`
        const payload = { type: 'status', status: 'interrupted', at: createdAt }
        const event = { sessionId: id, sequence, operationId, payload, createdAt }
        agentEvents.set(id, [...(agentEvents.get(id) ?? []), event])
        agentSessions.set(id, {
          ...session, status: 'interrupted', latestSequence: sequence, updatedAt: createdAt,
        })
        if (session.isPrimary) {
          const record = analyses.get(session.analysisId)
          if (record) analyses.set(session.analysisId, {
            ...record, status: 'interrupted', updatedAt: createdAt,
          })
        }
        interrupted.push(event)
      }
      return interrupted
    },
  }

  const runtimeSettingsRepository: RuntimeSettingsRepository = {
    async current() { return structuredClone(runtimeSettingsRevisions.at(-1)!) },
    async getRevision(id) {
      const revision = runtimeSettingsRevisions.find((candidate) => candidate.id === id)
      return revision ? structuredClone(revision) : null
    },
    async save(update, createdAt) {
      const revision = {
        id: ++nextSettingsRevisionId,
        values: { ...runtimeSettingsRevisions.at(-1)!.values, ...parseRuntimeSettingsUpdate(update) },
        createdAt,
      }
      runtimeSettingsRevisions.push(revision)
      return structuredClone(revision)
    },
    async restoreDefaults(createdAt) {
      const revision = { id: ++nextSettingsRevisionId, values: { ...defaultRuntimeSettings }, createdAt }
      runtimeSettingsRevisions.push(revision)
      return structuredClone(revision)
    },
    async freezeExecution(executionId, frozenAt) {
      const existing = executionSettingsSnapshots.get(executionId)
      if (existing) return structuredClone(existing)
      const current = runtimeSettingsRevisions.at(-1)!
      const snapshot = { executionId, id: current.id, values: { ...current.values }, createdAt: frozenAt }
      executionSettingsSnapshots.set(executionId, snapshot)
      return structuredClone(snapshot)
    },
    async getExecutionSnapshot(executionId) {
      const snapshot = executionSettingsSnapshots.get(executionId)
      return snapshot ? structuredClone(snapshot) : null
    },
    async listActiveExecutionSnapshots() {
      const activeExecutionIds = new Set([...agentSessions.values()]
        .filter(({ status }) => ['queued', 'running'].includes(status))
        .map(({ executionId }) => executionId))
      return [...executionSettingsSnapshots.values()]
        .filter(({ executionId }) => activeExecutionIds.has(executionId))
        .map((snapshot) => structuredClone(snapshot))
    },
  }

  return {
    productDatabase: {
      checkSchema: async () => ({ status: 'ok' as const, version: 6 }),
      close: async () => {},
    },
    portfolioRepository,
    analysisRepository,
    agentEventRepository,
    runtimeSettingsRepository,
  }
}
