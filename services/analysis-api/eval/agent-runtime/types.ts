import type { FastifyInstance } from 'fastify'
import type { RuntimeSettings } from '@vibe-invest/contracts'
import type { ModelEvent, ModelOptions } from '../../src/service/agent-runtime/model.js'
import type { FixtureWorld } from './harness/fixture.js'

export type EvalMode = 'fixture' | 'live'

export type EvalCheckResult = {
  id: string
  description: string
  status: 'pass' | 'fail' | 'skip'
  detail?: string
}

export type EvalStats = {
  durationMs: number
  modelRequests: number
  modelAttempts: number
  toolCalls: number
  toolRounds: number
  compactions: number
  contextTokens: number | null
  contextWindow: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  totalTokens: number | null
  specialistSessions: number
  assistantMessages: number
}

export type ObservedSession = {
  id: string
  isPrimary: boolean
  status: string
  executionId: string
  lifecycle: {
    status?: string
    terminal?: boolean
    events?: Array<Record<string, unknown>>
    tokenUsage?: Record<string, unknown> | null
    modelAttempts?: Array<Record<string, unknown>>
    compactions?: Array<Record<string, unknown>>
    compactionAttempts?: Array<Record<string, unknown>>
  } | null
}

export type EvalObservation = {
  caseId: string
  title: string
  mode: EvalMode
  target: 'analysis' | 'conversation'
  ok: boolean
  error?: string
  analysisId?: string
  threadId?: string
  record?: Record<string, unknown> | null
  research?: Record<string, unknown> | null
  sessions: ObservedSession[]
  reportVersions: Array<Record<string, unknown>>
  modelEvents: ModelEvent[]
  modelLog: Array<Record<string, unknown>>
  fixtureCalls: Array<Record<string, unknown>>
  stats: EvalStats
}

export type EvalRunContext = {
  mode: EvalMode
  fixture: FixtureWorld
  app: FastifyInstance
  database: {
    analysisRepository: { get(id: string): Promise<Record<string, unknown> | null> }
    conversationRepository: { get(id: string): Promise<Record<string, unknown> | null> }
  }
  modelEvents: ModelEvent[]
  modelLog: Array<Record<string, unknown>>
  waitForAnalysisTerminal(id: string, timeoutMs?: number): Promise<Record<string, unknown>>
  waitForThreadTerminal(id: string, timeoutMs?: number): Promise<Record<string, unknown>>
}

export type EvalCase = {
  id: string
  title: string
  category: 'lifecycle' | 'tools' | 'orchestration' | 'resilience' | 'safety' | 'quality'
  description: string
  tags: string[]
  modes: EvalMode[]
  target: 'analysis' | 'conversation'
  settings?: Partial<RuntimeSettings>
  modelOptions?: Partial<ModelOptions>
  fixtureOptions?: Record<string, unknown>
  modelScript?: (fixture: FixtureWorld) => ModelOptions['fauxResponses']
  run: (context: EvalRunContext) => Promise<{ analysisId?: string; threadId?: string }>
  checks: Array<(observation: EvalObservation) => EvalCheckResult | Promise<EvalCheckResult>>
}
