import { randomUUID } from 'node:crypto'

import type { PiAgentAdapterMessage, PiAgentAdapterTool } from './pi-agent-adapter.js'

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000

export class CompactionGenerationError extends Error {
  readonly usage: unknown
  constructor(cause: unknown, usage: unknown = null) {
    super('compaction_generation_failed', { cause })
    this.usage = usage
  }
}

export class CompactionCapacityExhaustedError extends Error {
  constructor() {
    super('compaction_capacity_exhausted')
    this.name = 'CompactionCapacityExhaustedError'
  }
}

class CompactionDidNotReduceError extends Error {
  constructor() {
    super('compaction_did_not_reduce_context')
  }
}

export type CompactionCut = {
  messagesToSummarize: PiAgentAdapterMessage[]
  turnPrefixMessages: PiAgentAdapterMessage[]
  retainedTail: PiAgentAdapterMessage[]
  isSplitTurn: boolean
}

export type CompactionMetrics = {
  contextTokens: number
  contextWindow: number
  reserveTokens: number
  keepRecentTokens: number
  estimated: boolean
}

export type CompactionOutcome =
  | { kind: 'compacted'; messages: PiAgentAdapterMessage[]; tokensAfter: number }
  | { kind: 'switch_to_finalization'; tools: PiAgentAdapterTool[] }

export type CompactionSink = {
  recordModelRequest(input: {
    requestId: string; projectionId: string; turnIndex: number; createdAt: string
  }): Promise<void>
  completeModelRequest(input: {
    requestId: string; status: 'completed' | 'failed' | 'cancelled'
    usage: unknown; completedAt: string
  }): Promise<void>
  recordCompactionAttempt(input: {
    id: string; attempt: number; durationMs: number; usage: unknown
    status: 'failed' | 'cancelled'; createdAt: string
  }): Promise<void>
  commitCompaction(input: {
    id: string; segmentId: string; operationId: string
    event: Record<string, unknown>
    contextTokens: number; contextWindow: number
    reserveTokens: number; keepRecentTokens: number
    tokensAfter: number
    summary: Record<string, unknown>; usage: unknown
    attempts: Array<{
      attempt: number; status: 'completed' | 'failed' | 'cancelled'
      durationMs: number; usage: unknown
    }>
    createdAt: string
  }): Promise<void>
  failCompaction(input: {
    id: string; operationId: string; event: Record<string, unknown>
    attempts: Array<{
      attempt: number; status: 'failed' | 'cancelled'; durationMs: number; usage: unknown
    }>
    createdAt: string
  }): Promise<void>
}

export function createCompactionCoordinator(options: {
  executionId: string
  role: 'main' | 'fundamental' | 'news' | 'technical'
  keepRecentTokens?: number
  sink: CompactionSink
  turnIndex: () => number
  activeProjectionId: () => string
  isAborted: () => boolean
  generate: (cut: CompactionCut, signal?: AbortSignal) => Promise<{
    narrative: string; usage: unknown
  }>
  buildSummary: (cut: CompactionCut, narrative: string) => Record<string, unknown>
  wrapSummary: (summary: Record<string, unknown>) => PiAgentAdapterMessage
  emit: (entry: Record<string, unknown>) => void
  switchToFinalization: (causativeEvent: Record<string, unknown>) => Promise<PiAgentAdapterTool[]>
}) {
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
  let index = 0
  let disabled = false
  let lastUsage: unknown = null
  let attemptResults: Array<{ attempt: number; durationMs: number; usage: unknown }> = []

  const compactionId = () => `execution:${options.executionId}:${options.role}:compaction:${index}`

  const fencedTolerant = async (write: () => Promise<void>) => {
    try {
      await write()
    } catch (error) {
      if (!(options.isAborted() && error instanceof Error
        && error.message === 'agent_execution_fenced')) throw error
    }
  }

  const persistFailure = async (outcome: 'fatal' | 'failed', metrics: CompactionMetrics) => {
    const operationId = `${compactionId()}:${outcome}`
    const event: Record<string, unknown> = {
      type: 'compaction', status: 'failed',
      attempts: outcome === 'failed' ? 2 : attemptResults.length,
      contextTokens: metrics.contextTokens, contextWindow: metrics.contextWindow,
      reserveTokens: metrics.reserveTokens, keepRecentTokens: metrics.keepRecentTokens,
      attemptResults, operationId,
    }
    await options.sink.failCompaction({
      id: compactionId(), operationId, event,
      attempts: attemptResults.map((attempt) => ({ ...attempt, status: 'failed' as const })),
      createdAt: new Date().toISOString(),
    })
    return event
  }

  return {
    get disabled() { return disabled },
    keepRecentTokens,
    async run(input: {
      cut: CompactionCut
      metrics: CompactionMetrics
      estimateTokensAfter: (candidate: PiAgentAdapterMessage[]) => number
      stillNeeded: (tokensAfter: number) => boolean
    }, signal?: AbortSignal): Promise<CompactionOutcome> {
      index += 1
      attemptResults = []
      for (const attempt of [1, 2] as const) {
        const attemptStartedAt = Date.now()
        lastUsage = null
        let requestId: string | undefined
        try {
          requestId = `${compactionId()}:attempt:${attempt}`
          await options.sink.recordModelRequest({
            requestId, projectionId: options.activeProjectionId(),
            turnIndex: Math.max(1, options.turnIndex()),
            createdAt: new Date().toISOString(),
          })
          const generated = await options.generate(input.cut, signal)
          lastUsage = generated.usage
          await fencedTolerant(() => options.sink.completeModelRequest({
            requestId: requestId!, status: 'completed', usage: generated.usage,
            completedAt: new Date().toISOString(),
          }))
          requestId = undefined
          const summary = options.buildSummary(input.cut, generated.narrative)
          const messages = [options.wrapSummary(summary), ...input.cut.retainedTail]
          const tokensAfter = input.estimateTokensAfter(messages)
          if (tokensAfter >= input.metrics.contextTokens || input.stillNeeded(tokensAfter)) {
            throw new CompactionDidNotReduceError()
          }
          const completedAt = new Date().toISOString()
          const durationMs = Date.parse(completedAt) - attemptStartedAt
          const segmentId = randomUUID()
          const operationId = `${compactionId()}:completed`
          const event: Record<string, unknown> = {
            type: 'compaction', status: 'completed', attempt, toSegmentId: segmentId,
            contextTokens: input.metrics.contextTokens,
            contextWindow: input.metrics.contextWindow,
            reserveTokens: input.metrics.reserveTokens,
            keepRecentTokens: input.metrics.keepRecentTokens,
            usage: generated.usage, durationMs, attemptResults,
          }
          await options.sink.commitCompaction({
            id: compactionId(), segmentId, operationId,
            event: { ...event, tokensAfter, estimated: true },
            contextTokens: input.metrics.contextTokens,
            contextWindow: input.metrics.contextWindow,
            reserveTokens: input.metrics.reserveTokens,
            keepRecentTokens: input.metrics.keepRecentTokens,
            tokensAfter, summary, usage: generated.usage,
            attempts: [
              ...attemptResults.map((item) => ({ ...item, status: 'failed' as const })),
              { attempt, status: 'completed' as const, durationMs, usage: generated.usage },
            ],
            createdAt: completedAt,
          })
          options.emit({
            type: 'compaction', status: 'completed', segmentId,
            contextTokens: input.metrics.contextTokens,
            contextWindow: input.metrics.contextWindow,
            reserveTokens: input.metrics.reserveTokens,
            keepRecentTokens: input.metrics.keepRecentTokens,
            tokensAfter, usage: generated.usage, durationMs,
            attemptResults, operationId,
          })
          return { kind: 'compacted', messages, tokensAfter }
        } catch (error) {
          const durationMs = Date.now() - attemptStartedAt
          const usage = error instanceof CompactionDidNotReduceError
            ? lastUsage
            : error instanceof CompactionGenerationError ? error.usage : null
          attemptResults.push({ attempt, durationMs, usage })
          if (requestId) {
            const failedRequestId = requestId
            await fencedTolerant(() => options.sink.completeModelRequest({
              requestId: failedRequestId,
              status: options.isAborted() ? 'cancelled' : 'failed',
              usage, completedAt: new Date().toISOString(),
            }))
            requestId = undefined
          }
          await fencedTolerant(() => options.sink.recordCompactionAttempt({
            id: compactionId(), attempt, durationMs, usage,
            status: options.isAborted() ? 'cancelled' : 'failed',
            createdAt: new Date().toISOString(),
          }))
          const retryable = error instanceof CompactionDidNotReduceError
            || error instanceof CompactionGenerationError
          if (!retryable) {
            const event = await persistFailure('fatal', input.metrics)
            options.emit(event)
            throw error
          }
        }
      }
      disabled = true
      const failedEvent = await persistFailure('failed', input.metrics)
      if (input.metrics.contextTokens >= input.metrics.contextWindow) {
        options.emit(failedEvent)
        throw new CompactionCapacityExhaustedError()
      }
      const tools = await options.switchToFinalization(failedEvent)
      options.emit(failedEvent)
      return { kind: 'switch_to_finalization', tools }
    },
  }
}
