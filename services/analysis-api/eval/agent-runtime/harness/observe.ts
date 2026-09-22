import type { FastifyInstance } from 'fastify'
import type { ModelEvent } from '../../../src/service/agent-runtime/model.js'
import type { FixtureWorld } from './fixture.js'
import type { EvalObservation, EvalStats, ObservedSession } from '../types.js'

const terminalAnalysisStatuses = new Set([
  'completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted',
])
const terminalThreadStatuses = new Set(['completed', 'failed', 'stopped', 'interrupted'])

export async function waitForAnalysisTerminal(
  app: FastifyInstance, analysisId: string, timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  let latest: Record<string, unknown> = {}
  while (Date.now() - startedAt < timeoutMs) {
    const response = await app.inject({ method: 'GET', url: `/api/research/${analysisId}` })
    if (response.statusCode === 200) {
      latest = response.json() as Record<string, unknown>
      const status = String(latest.status ?? '')
      if (terminalAnalysisStatuses.has(status)) return latest
    } else {
      const status = await getAnalysisStatus(app, analysisId)
      if (status) latest = status
      if (terminalAnalysisStatuses.has(String(status?.status ?? ''))) return latest
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`analysis_wait_timeout:${analysisId}:${JSON.stringify(latest)}`)
}

async function getAnalysisStatus(app: FastifyInstance, id: string) {
  const direct = await app.inject({ method: 'GET', url: `/api/research/${id}/trace` })
  if (direct.statusCode !== 200) return null
  const body = direct.json() as Record<string, unknown>
  const main = body.mainAgent as Record<string, unknown> | undefined
  const execution = main?.execution as Record<string, unknown> | undefined
  return execution ? { status: execution.status, terminal: execution.terminal } : null
}

export async function waitForThreadTerminal(
  app: FastifyInstance, threadId: string, timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const response = await app.inject({ method: 'GET', url: `/api/conversations/${threadId}` })
    if (response.statusCode === 200) {
      const body = response.json() as Record<string, unknown>
      const thread = body.thread as Record<string, unknown> | undefined
      if (terminalThreadStatuses.has(String(thread?.status))) return body
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`conversation_wait_timeout:${threadId}`)
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return (event.payload && typeof event.payload === 'object')
    ? event.payload as Record<string, unknown>
    : event
}

function allPayloads(sessions: ObservedSession[]): Array<Record<string, unknown>> {
  return sessions.flatMap((session) => (session.lifecycle?.events ?? []).map(payloadOf))
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function computeStats(input: {
  durationMs: number
  sessions: ObservedSession[]
  fixtureCalls: Array<Record<string, unknown>>
  modelEvents: ModelEvent[]
}): EvalStats {
  const payloads = allPayloads(input.sessions)
  const modelAttempts = input.sessions.flatMap((session) => session.lifecycle?.modelAttempts ?? [])
  const toolCalls = payloads.filter((payload) => payload.type === 'tool_call')
  const toolRounds = payloads.filter((payload) => payload.type === 'runtime_turn_advanced').length
  const compactions = input.sessions.flatMap((session) => session.lifecycle?.compactions ?? [])
  const assistantMessages = payloads.filter((payload) => payload.type === 'assistant_message')
  const contextUsage = payloads.filter((payload) => payload.type === 'context_usage').at(-1)
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let cachedInputTokens: number | null = null
  let totalTokens: number | null = null
  for (const session of input.sessions) {
    const usage = session.lifecycle?.tokenUsage as Record<string, unknown> | undefined
    const add = (current: number | null, value: unknown) => {
      const numeric = asNumber(value)
      if (numeric === null) return current
      return (current ?? 0) + numeric
    }
    inputTokens = add(inputTokens, usage?.input)
    outputTokens = add(outputTokens, usage?.output)
    cachedInputTokens = add(cachedInputTokens, usage?.cacheRead)
    totalTokens = add(totalTokens, usage?.total)
  }

  return {
    durationMs: input.durationMs,
    modelRequests: modelAttempts.length,
    modelAttempts: modelAttempts.length,
    toolCalls: toolCalls.length,
    toolRounds,
    compactions: compactions.length,
    contextTokens: asNumber(contextUsage?.contextTokens),
    contextWindow: asNumber(contextUsage?.contextWindow),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    specialistSessions: input.sessions.filter((session) => session.isPrimary === false).length,
    assistantMessages: assistantMessages.length,
  }
}

export async function collectSessions(
  database: {
    agentEventRepository: {
      listSessions(analysisId: string): Promise<Array<Record<string, unknown>>>
      sessionLifecycle(sessionId: string): Promise<Record<string, unknown> | null>
    }
  },
  analysisId: string,
): Promise<ObservedSession[]> {
  const sessions = await database.agentEventRepository.listSessions(analysisId)
  return Promise.all(sessions.map(async (session) => ({
    id: String(session.id),
    isPrimary: Boolean(session.isPrimary),
    status: String(session.status),
    executionId: String(session.executionId),
    lifecycle: await database.agentEventRepository.sessionLifecycle(String(session.id)) as ObservedSession['lifecycle'],
  })))
}

export async function collectAnalysisObservation(input: {
  mode: 'fixture' | 'live'
  caseId: string
  title: string
  analysisId: string
  app: FastifyInstance
  database: {
    agentEventRepository: {
      listSessions(analysisId: string): Promise<Array<Record<string, unknown>>>
      sessionLifecycle(sessionId: string): Promise<Record<string, unknown> | null>
      listReportVersions(analysisId: string): Promise<Array<Record<string, unknown>>>
    }
  }
  fixtureCalls: Array<Record<string, unknown>>
  modelEvents: ModelEvent[]
  startedAt: number
  error?: string
}): Promise<EvalObservation> {
  const sessions = await collectSessions(input.database, input.analysisId)
  const researchResponse = await input.app.inject({ method: 'GET', url: `/api/research/${input.analysisId}` })
  const recordResponse = await input.app.inject({ method: 'GET', url: `/api/research/${input.analysisId}/trace` })
  return {
    caseId: input.caseId,
    title: input.title,
    mode: input.mode,
    target: 'analysis',
    ok: input.error === undefined,
    ...(input.error === undefined ? {} : { error: input.error }),
    analysisId: input.analysisId,
    record: recordResponse.statusCode === 200 ? recordResponse.json() as Record<string, unknown> : null,
    research: researchResponse.statusCode === 200 ? researchResponse.json() as Record<string, unknown> : null,
    sessions,
    reportVersions: await input.database.agentEventRepository.listReportVersions(input.analysisId),
    modelEvents: input.modelEvents,
    modelLog: [],
    fixtureCalls: input.fixtureCalls,
    stats: computeStats({
      durationMs: Date.now() - input.startedAt,
      sessions,
      fixtureCalls: input.fixtureCalls,
      modelEvents: input.modelEvents,
    }),
  }
}

export async function collectConversationObservation(input: {
  mode: 'fixture' | 'live'
  caseId: string
  title: string
  threadId: string
  app: FastifyInstance
  database: {
    agentEventRepository: {
      listSessions(analysisId: string): Promise<Array<Record<string, unknown>>>
      sessionLifecycle(sessionId: string): Promise<Record<string, unknown> | null>
      listReportVersions(analysisId: string): Promise<Array<Record<string, unknown>>>
    }
  }
  fixtureCalls: Array<Record<string, unknown>>
  modelEvents: ModelEvent[]
  startedAt: number
  error?: string
}): Promise<EvalObservation> {
  const sessions = await collectSessions(input.database, input.threadId)
  const detail = await input.app.inject({ method: 'GET', url: `/api/conversations/${input.threadId}` })
  return {
    caseId: input.caseId,
    title: input.title,
    mode: input.mode,
    target: 'conversation',
    ok: input.error === undefined,
    ...(input.error === undefined ? {} : { error: input.error }),
    threadId: input.threadId,
    research: detail.statusCode === 200 ? detail.json() as Record<string, unknown> : null,
    sessions,
    reportVersions: await input.database.agentEventRepository.listReportVersions(input.threadId),
    modelEvents: input.modelEvents,
    modelLog: [],
    fixtureCalls: input.fixtureCalls,
    stats: computeStats({
      durationMs: Date.now() - input.startedAt,
      sessions,
      fixtureCalls: input.fixtureCalls,
      modelEvents: input.modelEvents,
    }),
  }
}
