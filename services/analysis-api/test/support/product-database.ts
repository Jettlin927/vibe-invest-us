import type {
  AgentEvent, AgentEventRepository, AgentSession, AnalysisRecord, AnalysisRepository, PortfolioRepository,
  ProductEquitySnapshot, RuntimeSettingsRepository,
  ToolProjectionRepository,
  ProductPosition,
} from '@vibe-invest/product-dao'
import {
  aggregateModelTokenUsage, defaultRuntimeSettings, parseRuntimeSettingsUpdate,
} from '@vibe-invest/contracts'

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
  const reportVersions = new Map<string, Array<{
    id: string; analysisId: string; sessionId: string; executionId: string; version: number
    kind: 'integrated' | 'specialist'; payloadHash: string; report: unknown; createdAt: string
  }>>()
  const lifecycles = new Map<string, {
    execution: { id: string; generation: number; status: string; createdAt: string; updatedAt: string }
    waitReason: { kind: 'database'; target: string; startedAt: string }
    segments: Array<{
      id: string; ordinal: number; parentSegmentId?: string | null; createdAt: string
    }>
    compactions?: Array<{
      id: string; fromSegmentId: string; toSegmentId: string
      summary: Record<string, unknown>; usage: Record<string, unknown>; createdAt: string
    }>
  }>()
  let nextSettingsRevisionId = 1
  const runtimeSettingsRevisions = [{
    id: nextSettingsRevisionId, values: { ...defaultRuntimeSettings }, createdAt: '2026-08-13T00:00:00.000Z',
  }]
  const executionSettingsSnapshots = new Map<string, Awaited<ReturnType<RuntimeSettingsRepository['freezeExecution']>>>()
  const toolProjections = new Map<string, Array<{
    id: string; executionId: string; version: number; role: string; stage: string; schemaHash: string
    projectedTools: unknown[]; visibleToolNames: string[]
    reasons: Record<string, unknown>; createdAt: string
  }>>()
  const modelRequests: Array<{
    id: string; sessionId: string; executionId: string; projectionId: string; turnIndex: number
    kind: 'turn' | 'compaction'; status: string; usageStatus: string
    usage: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; total: number | null }
    createdAt: string; completedAt: string | null
  }> = []
  const modelUsage = (sessionId: string) => {
    const attempts = modelRequests.filter((request) => request.sessionId === sessionId)
    return {
      modelAttempts: attempts.map((attempt) => ({
        ...structuredClone(attempt),
        durationMs: attempt.completedAt
          ? Math.max(0, Date.parse(attempt.completedAt) - Date.parse(attempt.createdAt)) : null,
      })),
      tokenUsage: aggregateModelTokenUsage(attempts),
    }
  }
  const toolBatches = new Map<string, {
    id: string; executionId: string; projectionId: string; turnIndex: number; status: string
    calls: Array<{ toolCallId: string; toolName: string; position: number }>
    results: Array<{
      toolCallId: string; status: string; startedAt: string | null; completedAt: string
      completionOrder: number; resultPayload: Record<string, unknown>
    }>
  }>()

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
        reportCreatedAt: extra.report ? updatedAt : record.reportCreatedAt,
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
      analyses.set(record.id, { ...record, snapshot: null, report: null, reportCreatedAt: null, error: null, starred: false, note: '' })
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
      if (record && !['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted']
        .includes(record.status)) analyses.set(id, { ...record, snapshot })
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
        ['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted'].includes(record.status)
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
    async commitCompaction(input) {
      const session = [...agentSessions.values()].find((candidate) => (
        candidate.executionId === input.executionId
      ))
      if (!session) throw new Error('agent_execution_fenced')
      const lifecycle = lifecycles.get(session.id)
      if (!lifecycle || lifecycle.execution.id !== input.executionId
        || ['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted']
          .includes(lifecycle.execution.status)) throw new Error('agent_execution_fenced')
      const events = agentEvents.get(session.id) ?? []
      const replay = events.find(({ operationId }) => operationId === input.operationId)
      if (replay) return { created: false, event: replay, segmentId: input.segmentId }
      const current = lifecycle.segments.at(-1)
      if (!current) throw new Error('conversation_segment_not_found')
      const event = {
        sessionId: session.id, sequence: session.latestSequence + 1,
        operationId: input.operationId, payload: structuredClone(input.event),
        createdAt: input.createdAt,
      }
      agentEvents.set(session.id, [...events, event])
      agentSessions.set(session.id, {
        ...session, latestSequence: event.sequence, updatedAt: input.createdAt,
      })
      lifecycles.set(session.id, {
        ...lifecycle,
        segments: [...lifecycle.segments, {
          id: input.segmentId, ordinal: current.ordinal + 1,
          parentSegmentId: current.id, createdAt: input.createdAt,
        }],
        compactions: [...(lifecycle.compactions ?? []), {
          id: input.id, fromSegmentId: current.id, toSegmentId: input.segmentId,
          summary: structuredClone(input.summary), usage: structuredClone(input.usage),
          createdAt: input.createdAt,
        }],
      })
      return { created: true, event, segmentId: input.segmentId }
    },
    async failCompaction(input) {
      const session = [...agentSessions.values()].find((candidate) => (
        candidate.executionId === input.executionId
      ))
      if (!session) throw new Error('agent_execution_fenced')
      const events = agentEvents.get(session.id) ?? []
      const replay = events.find(({ operationId }) => operationId === input.operationId)
      if (replay) return { created: false, event: replay }
      const event = {
        sessionId: session.id, sequence: session.latestSequence + 1,
        operationId: input.operationId, payload: structuredClone(input.event),
        createdAt: input.createdAt,
      }
      agentEvents.set(session.id, [...events, event])
      agentSessions.set(session.id, {
        ...session, latestSequence: event.sequence, updatedAt: input.createdAt,
      })
      return { created: true, event }
    },
    async recordCompactionAttempt() {},
    async resumeResearch(input) {
      const record = analyses.get(input.analysisId)
      const session = [...agentSessions.values()].find((candidate) => (
        candidate.analysisId === input.analysisId && candidate.isPrimary
      ))
      if (!record || !session) throw new Error('analysis_not_found')
      const lifecycle = lifecycles.get(session.id)!
      if (!['stopped', 'interrupted'].includes(record.status)
        || !['stopped', 'interrupted'].includes(lifecycle.execution.status)) {
        throw new Error('analysis_not_resumable')
      }
      const generation = lifecycle.execution.generation + 1
      const sequence = session.latestSequence + 1
      agentEvents.set(session.id, [...(agentEvents.get(session.id) ?? []), {
        sessionId: session.id, sequence, operationId: input.operationId,
        payload: input.event, createdAt: input.createdAt,
      }])
      agentSessions.set(session.id, {
        ...session, executionId: input.executionId, status: 'planning',
        latestSequence: sequence, updatedAt: input.createdAt,
      })
      lifecycles.set(session.id, {
        execution: {
          id: input.executionId, generation, status: 'planning',
          createdAt: input.createdAt, updatedAt: input.createdAt,
        },
        waitReason: { kind: 'database', target: '恢复研究上下文', startedAt: input.createdAt },
        segments: [...lifecycle.segments, {
          id: input.segmentId ?? `${session.id}:segment:${lifecycle.segments.length + 1}`,
          ordinal: lifecycle.segments.length + 1, createdAt: input.createdAt,
        }],
        compactions: lifecycle.compactions ?? [],
      })
      analyses.set(input.analysisId, {
        ...record, status: 'queued', terminal: false, error: null, updatedAt: input.createdAt,
      })
      const current = runtimeSettingsRevisions.at(-1)!
      executionSettingsSnapshots.set(input.executionId, {
        executionId: input.executionId, id: current.id,
        values: { ...current.values }, createdAt: input.createdAt,
      })
      return { sessionId: session.id, executionId: input.executionId, generation, created: true }
    },
    async fenceForStopping(input) {
      const session = agentSessions.get(input.sessionId)
      const lifecycle = lifecycles.get(input.sessionId)
      if (!session || !lifecycle) throw new Error('agent_session_not_found')
      if (session.executionId !== input.executionId) throw new Error('agent_execution_fenced')
      const fencedSessions = [...agentSessions.values()].filter((candidate) => (
        candidate.analysisId === session.analysisId
        && !['completed', 'partial', 'failed', 'stopped', 'interrupted'].includes(candidate.status)
      )).map((candidate) => {
        const candidateLifecycle = lifecycles.get(candidate.id)!
        const fenceExecutionId = candidate.id === input.sessionId
          ? input.fenceExecutionId : `${input.fenceExecutionId}:session:${candidate.id}`
        const operationId = candidate.id === input.sessionId
          ? input.operationId : `${input.operationId}:session:${candidate.id}`
        const payload = candidate.id === input.sessionId ? input.event : {
          ...input.event, previousExecutionId: candidate.executionId,
        }
        const event = {
          sessionId: candidate.id, sequence: candidate.latestSequence + 1,
          operationId, payload, createdAt: input.createdAt,
        }
        agentEvents.set(candidate.id, [...(agentEvents.get(candidate.id) ?? []), event])
        agentSessions.set(candidate.id, {
          ...candidate, executionId: fenceExecutionId, status: 'stopping',
          latestSequence: event.sequence, updatedAt: input.createdAt,
        })
        lifecycles.set(candidate.id, {
          ...candidateLifecycle,
          execution: {
            id: fenceExecutionId, generation: candidateLifecycle.execution.generation + 1,
            status: 'stopping', createdAt: input.createdAt, updatedAt: input.createdAt,
          },
          waitReason: input.event.waitReason as never,
        })
        return { ...event, executionId: fenceExecutionId }
      })
      const record = analyses.get(session.analysisId)
      if (record && session.isPrimary) analyses.set(session.analysisId, {
        ...record, status: 'stopping', terminal: false, updatedAt: input.createdAt,
      })
      const event = fencedSessions.find(({ sessionId }) => sessionId === input.sessionId)!
      return { ...event, cancelledToolEvents: [], fencedSessions }
    },
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
      lifecycles.set(input.sessionId, {
        execution: { id: input.executionId, generation: 1, status: 'planning', createdAt: input.createdAt, updatedAt: input.createdAt },
        waitReason: { kind: 'database', target: '首次研究初始化', startedAt: input.createdAt },
        segments: [{ id: input.segmentId ?? `${input.sessionId}:segment:1`, ordinal: 1, createdAt: input.createdAt }],
      })
      executionSettingsSnapshots.set(input.executionId, {
        executionId: input.executionId,
        id: runtimeSettingsRevisions.at(-1)!.id,
        values: { ...runtimeSettingsRevisions.at(-1)!.values },
        createdAt: input.createdAt,
      })
      analyses.set(input.analysisId, {
        id: input.analysisId, symbol: input.symbol, status: input.analysisStatus ?? input.status,
        createdAt: input.createdAt, updatedAt: input.createdAt,
        snapshot: null, report: null, reportCreatedAt: null, error: null, starred: false, note: '',
      })
      return {
        analysisId: input.analysisId, sessionId: input.sessionId,
        sequence: 1, created: true, event,
      }
    },
    async createSpecialistSession(input) {
      const existing = [...agentSessions.values()].find((session) => (
        session.analysisId === input.analysisId
        && (agentEvents.get(session.id)?.[0]?.payload as Record<string, unknown> | undefined)?.domain === input.domain
      ))
      if (existing) {
        const replay = (agentEvents.get(existing.id) ?? []).find(
          ({ operationId }) => operationId === input.operationId,
        )
        if (replay) {
          if (existing.executionId !== input.executionId
            || JSON.stringify(replay.payload) !== JSON.stringify(input.event)
            || replay.createdAt !== input.createdAt) throw new Error('agent_operation_conflict')
          return { sessionId: existing.id, executionId: input.executionId, created: false }
        }
        const lifecycle = lifecycles.get(existing.id)!
        if (!['completed', 'partial', 'failed', 'cancelled', 'budget_exhausted', 'stopped',
          'interrupted'].includes(lifecycle.execution.status)) return {
            sessionId: existing.id, executionId: existing.executionId, created: false,
          }
        const sequence = existing.latestSequence + 1
        agentEvents.set(existing.id, [...(agentEvents.get(existing.id) ?? []), {
          sessionId: existing.id, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        }])
        agentSessions.set(existing.id, {
          ...existing, executionId: input.executionId, status: 'planning',
          latestSequence: sequence, updatedAt: input.createdAt,
        })
        lifecycles.set(existing.id, {
          execution: { id: input.executionId, generation: lifecycle.execution.generation + 1,
            status: 'planning', createdAt: input.createdAt, updatedAt: input.createdAt },
          waitReason: { kind: 'database', target: '专项研究规划', startedAt: input.createdAt },
          segments: [...lifecycle.segments, {
            id: input.segmentId ?? `${existing.id}:segment:${lifecycle.segments.length + 1}`,
            ordinal: lifecycle.segments.length + 1, createdAt: input.createdAt,
          }],
        })
        const current = runtimeSettingsRevisions.at(-1)!
        executionSettingsSnapshots.set(input.executionId, {
          executionId: input.executionId, id: current.id,
          values: { ...current.values }, createdAt: input.createdAt,
        })
        return { sessionId: existing.id, executionId: input.executionId, created: true }
      }
      await this.createSession(input)
      return { sessionId: input.id, executionId: input.executionId, created: true }
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
      const executionStatus = input.status === 'queued' ? 'planning'
        : input.status === 'running' ? 'running_model' : input.status
      lifecycles.set(input.id, {
        execution: { id: input.executionId, generation: 1, status: executionStatus, createdAt: input.createdAt, updatedAt: input.createdAt },
        waitReason: executionStatus === 'planning'
          ? { kind: 'database', target: '研究规划', startedAt: input.createdAt }
          : { kind: 'database', target: '模型响应', startedAt: input.createdAt },
        segments: [{ id: input.segmentId ?? `${input.id}:segment:1`, ordinal: 1, createdAt: input.createdAt }],
      })
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
      if (session.executionId !== input.executionId) throw new Error('agent_execution_fenced')
      const event = {
        sessionId: input.sessionId, sequence: session.latestSequence + 1,
        operationId: input.operationId, payload: input.event, createdAt: input.createdAt,
      }
      agentEvents.set(input.sessionId, [...events, event])
      agentSessions.set(input.sessionId, {
        ...session, status: input.projection?.status ?? session.status,
        latestSequence: event.sequence, updatedAt: input.createdAt,
      })
      const lifecycle = lifecycles.get(input.sessionId)
      if (lifecycle && input.projection?.executionStatus) {
        const status = input.projection.executionStatus
        const waitKind = ({ planning: 'database', running_model: 'model', running_tools: 'tools', waiting_for_specialists: 'specialists', finalizing: 'finalizing' } as const)[status as 'planning']
        lifecycles.set(input.sessionId, {
          ...lifecycle,
          execution: { ...lifecycle.execution, status, updatedAt: input.createdAt },
          waitReason: waitKind ? { kind: waitKind as 'database', target: input.projection.waitTarget ?? ({ planning: '研究规划', running_model: '主模型响应', running_tools: '工具结果', waiting_for_specialists: '专项分析', finalizing: '报告收口' } as Record<string, string>)[status], startedAt: input.createdAt } : null as never,
        })
      }
      if (input.projection) {
        const analysisId = session.analysisId
        if (input.projection.reportVersion) {
          const versions = reportVersions.get(analysisId) ?? []
          const sessionVersion = versions.filter(({ sessionId }) => sessionId === input.sessionId).length + 1
          reportVersions.set(analysisId, [...versions, {
            ...input.projection.reportVersion,
            analysisId, sessionId: input.sessionId, executionId: input.executionId,
            version: sessionVersion, createdAt: input.createdAt,
          }])
        }
        for (const fact of input.projection.facts ?? []) {
          facts.set(fact.id, fact)
          const ids = analysisFacts.get(analysisId) ?? new Set()
          ids.add(fact.id)
          analysisFacts.set(analysisId, ids)
        }
        const record = analyses.get(analysisId)
        if (record && session.isPrimary) analyses.set(analysisId, {
          ...record, status: input.projection.status ?? record.status, updatedAt: input.createdAt,
          ...(typeof input.event.terminal === 'boolean' ? { terminal: input.event.terminal } : {}),
          report: input.projection.report ?? record.report,
          reportCreatedAt: input.projection.report ? input.createdAt : record.reportCreatedAt,
          snapshot: input.projection.snapshot ?? record.snapshot,
          error: input.projection.error ?? record.error,
        })
      }
      return { sequence: event.sequence, created: true, event }
    },
    async listReportVersions(analysisId) {
      return structuredClone(reportVersions.get(analysisId) ?? [])
    },
    async list(sessionId, afterSequence) {
      return (agentEvents.get(sessionId) ?? []).filter(({ sequence }) => sequence > afterSequence)
    },
    async listByExecution(executionId, afterSequence) {
      const session = [...agentSessions.values()].find((candidate) => (
        candidate.executionId === executionId
      ))
      return session
        ? (agentEvents.get(session.id) ?? []).filter(({ sequence }) => sequence > afterSequence)
        : []
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
    async sessionLifecycle(sessionId) {
      const session = agentSessions.get(sessionId)
      const lifecycle = lifecycles.get(sessionId)
      if (!session || !lifecycle) return null
      return {
        ...session, status: lifecycle.execution.status, waitReason: lifecycle.waitReason,
        execution: lifecycle.execution, segments: lifecycle.segments,
        compactions: lifecycle.compactions ?? [],
        events: (agentEvents.get(sessionId) ?? []).map((event) => ({
          sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
        })),
        ...modelUsage(sessionId),
      }
    },
    async primaryLifecycle(analysisId) {
      const session = [...agentSessions.values()].find((candidate) => candidate.analysisId === analysisId && candidate.isPrimary)
      if (!session) return null
      const lifecycle = lifecycles.get(session.id)
      if (!lifecycle) return null
      return {
        ...session, status: lifecycle.execution.status, waitReason: lifecycle.waitReason,
        execution: lifecycle.execution, segments: lifecycle.segments,
        compactions: lifecycle.compactions ?? [],
        events: (agentEvents.get(session.id) ?? []).map((event) => ({
          sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
        })),
        ...modelUsage(session.id),
      }
    },
    async interruptActiveSessions(createdAt) {
      const interrupted: AgentEvent[] = []
      for (const [id, session] of [...agentSessions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const lifecycle = lifecycles.get(id)
        if (!lifecycle || !['planning', 'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing', 'stopping'].includes(lifecycle.execution.status)) continue
        const sequence = session.latestSequence + 1
        const operationId = `startup:interrupt:${id}:${sequence}`
        const payload = {
          type: 'status', status: 'interrupted', previousExecutionId: session.executionId,
          at: createdAt,
        }
        const event = { sessionId: id, sequence, operationId, payload, createdAt }
        agentEvents.set(id, [...(agentEvents.get(id) ?? []), event])
        agentSessions.set(id, {
          ...session, status: 'interrupted', latestSequence: sequence, updatedAt: createdAt,
        })
        lifecycles.set(id, {
          ...lifecycle,
          execution: { ...lifecycle.execution, status: 'interrupted', updatedAt: createdAt },
          waitReason: null as never,
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
        .filter(({ id }) => {
          const status = lifecycles.get(id)?.execution.status
          return status && ['planning', 'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing', 'stopping'].includes(status)
        })
        .map(({ executionId }) => executionId))
      return [...executionSettingsSnapshots.values()]
        .filter(({ executionId }) => activeExecutionIds.has(executionId))
        .map((snapshot) => structuredClone(snapshot))
    },
  }
  const toolProjectionRepository: ToolProjectionRepository = {
    async ensureVersion(input) {
      const versions = toolProjections.get(input.executionId) ?? []
      const existing = versions.find((projection) => projection.role === input.role
        && projection.stage === input.stage && projection.schemaHash === input.schemaHash
        && JSON.stringify(projection.visibleToolNames) === JSON.stringify(input.visibleToolNames))
      if (existing) return structuredClone(existing)
      if ([...toolBatches.values()].some((batch) => batch.executionId === input.executionId
        && batch.status === 'running')) throw new Error('tool_batch_not_terminal')
      const projection = {
        ...input, id: `${input.executionId}:tool-projection:${versions.length + 1}`,
        version: versions.length + 1,
      }
      let event
      if (input.causativeEvent) {
        const session = [...agentSessions.values()].find(({ executionId }) => executionId === input.executionId)!
        const existing = agentEvents.get(session.id)?.find(
          ({ operationId }) => operationId === input.causativeEvent!.operationId,
        )
        event = await agentEventRepository.append({
          sessionId: session.id, executionId: input.executionId,
          operationId: input.causativeEvent.operationId, event: input.causativeEvent.payload,
          createdAt: input.createdAt,
        })
        if (existing) event = undefined
      }
      toolProjections.set(input.executionId, [...versions, projection])
      return { ...structuredClone(projection), event }
    },
    async recordModelRequest(input) {
      if (!modelRequests.some(({ id }) => id === input.id)) modelRequests.push({
        ...structuredClone(input),
        sessionId: [...agentSessions.values()].find(({ executionId }) => (
          executionId === input.executionId
        ))?.id ?? (() => { throw new Error('agent_execution_fenced') })(),
        kind: input.kind ?? 'turn', status: 'started', usageStatus: 'unknown',
        usage: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null },
        completedAt: null,
      })
    },
    async completeModelRequest(input) {
      const request = modelRequests.find(({ id }) => id === input.id)
      if (!request) throw new Error('model_request_not_found')
      if (request.status !== 'started') return { created: false }
      request.status = input.status
      request.usageStatus = input.usageStatus
      request.usage = structuredClone(input.usage)
      request.completedAt = input.completedAt
      return { created: true }
    },
    async beginToolBatch(input) {
      toolBatches.set(input.id, { ...structuredClone(input), status: 'running', results: [] })
    },
    async startToolCall(input) {
      const session = [...agentSessions.values()].find(({ executionId }) => executionId === input.executionId)
      if (!session) throw new Error('agent_execution_fenced')
      const lifecycle = lifecycles.get(session.id)
      if (!lifecycle || lifecycle.execution.id !== input.executionId
        || ['completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted']
          .includes(lifecycle.execution.status)) throw new Error('agent_execution_fenced')
      const batch = toolBatches.get(input.batchId)
      if (!batch || batch.executionId !== input.executionId || batch.status !== 'running'
        || !batch.calls.some(({ toolCallId }) => toolCallId === input.toolCallId)) {
        throw new Error('tool_call_not_running')
      }
      const existing = agentEvents.get(session.id) ?? []
      const prior = existing.find(({ operationId }) => operationId === input.operationId)
      if (prior) return structuredClone(prior)
      const event = {
        sessionId: session.id, sequence: existing.length + 1, operationId: input.operationId,
        payload: structuredClone(input.eventPayload), createdAt: input.startedAt,
      }
      agentEvents.set(session.id, [...existing, event])
      return structuredClone(event)
    },
    async completeToolBatch(input) {
      const batch = toolBatches.get(input.id)
      if (!batch) throw new Error('tool_batch_not_found')
      if (input.results.length !== batch.calls.length) throw new Error('tool_batch_not_terminal')
      const results = input.results.map((result) => ({
        toolCallId: result.toolCallId, status: result.status, startedAt: result.startedAt,
        completedAt: result.completedAt, completionOrder: result.completionOrder,
        resultPayload: structuredClone(result.resultPayload),
      }))
      const status = results.some((result) => result.status === 'failed') ? 'failed'
        : results.some((result) => result.status === 'cancelled') ? 'cancelled' : 'completed'
      toolBatches.set(input.id, { ...batch, status, results })
      const session = [...agentSessions.values()].find(({ executionId }) => executionId === input.executionId)
      if (!session) return []
      const existing = agentEvents.get(session.id) ?? []
      const created = [...input.results]
        .sort((left, right) => left.completionOrder - right.completionOrder)
        .map((result, index) => ({
          sessionId: session.id, sequence: existing.length + index + 1,
          operationId: result.operationId, payload: structuredClone(result.eventPayload),
          createdAt: result.completedAt,
        }))
      agentEvents.set(session.id, [...existing, ...created])
      for (const result of input.results) {
        const resultValue = result.eventPayload.result as { facts?: Array<Record<string, unknown>> } | undefined
        for (const fact of resultValue?.facts ?? []) {
          if (typeof fact.id !== 'string') continue
          facts.set(fact.id, structuredClone(fact))
          const ids = analysisFacts.get(session.analysisId) ?? new Set<string>()
          ids.add(fact.id)
          analysisFacts.set(session.analysisId, ids)
        }
      }
      let projection
      if (input.advance) {
        const versions = toolProjections.get(input.executionId) ?? []
        projection = {
          executionId: input.executionId, role: input.advance.role, stage: input.advance.stage,
          schemaHash: input.advance.schemaHash,
          projectedTools: structuredClone(input.advance.projectedTools),
          visibleToolNames: structuredClone(input.advance.visibleToolNames), reasons: {
            toolRounds: input.advance.toolRounds, activeElapsedMs: input.advance.activeElapsedMs,
          }, createdAt: input.completedAt,
          id: `${input.executionId}:tool-projection:${versions.length + 1}`, version: versions.length + 1,
        }
        toolProjections.set(input.executionId, [...versions, projection])
        const turnEvent = await agentEventRepository.append({
          sessionId: session.id, executionId: input.executionId,
          operationId: `${input.id}:turn-advanced`, event: {
            type: 'runtime_turn_advanced', toolRounds: input.advance.toolRounds,
            activeElapsedMs: input.advance.activeElapsedMs, stage: input.advance.stage,
          }, createdAt: input.completedAt,
        })
        created.push(turnEvent)
        if (input.advance.causativeEvent) created.push(await agentEventRepository.append({
          sessionId: session.id, executionId: input.executionId,
          operationId: input.advance.causativeEvent.operationId,
          event: input.advance.causativeEvent.payload, createdAt: input.completedAt,
        }))
      }
      return { events: created, projection }
    },
    async replay(executionId) {
      const projections = toolProjections.get(executionId) ?? []
      return {
        projections: structuredClone(projections),
        modelRequests: modelRequests.filter((request) => request.executionId === executionId).map((request) => ({
          id: request.id, turnIndex: request.turnIndex,
          projectionVersion: projections.find(({ id }) => id === request.projectionId)?.version ?? 0,
          createdAt: request.createdAt,
        })),
        toolBatches: [...toolBatches.values()].filter((batch) => batch.executionId === executionId)
          .map((batch) => ({
            ...structuredClone(batch),
            projectionVersion: projections.find(({ id }) => id === batch.projectionId)?.version ?? 0,
          })),
      }
    },
    async replayForSession(sessionId, executionId) {
      const belongs = lifecycles.get(sessionId)?.execution.id === executionId
        || agentSessions.get(sessionId)?.executionId === executionId
      return belongs ? { executionId, ...await this.replay(executionId) } : null
    },
  }

  return {
    productDatabase: {
      checkSchema: async () => ({ status: 'ok' as const, version: 22 }),
      close: async () => {},
    },
    portfolioRepository,
    analysisRepository,
    agentEventRepository,
    runtimeSettingsRepository,
    toolProjectionRepository,
  }
}
