import { createModels, type FauxResponseStep, type Tool } from '@earendil-works/pi-ai'
import type { RuntimeSettings } from '@vibe-invest/contracts'

import type { ActiveBudget } from './runtime-policy.js'
import { createProjectedPiModel } from './projected-pi-model.js'

type Fact = {
  id: string
  type: string
  value: unknown
  observedAt: string
  fetchedAt: string
  source: string
  sourceReference: string
}

export type AnalysisReport = {
  title: string
  marketState: string
  trend: string
  drivers: string[]
  supportingEvidence: string[]
  contraryEvidence: string[]
  scenarios: Array<{ name: string; condition: string; outcome: string }>
  invalidationConditions: string[]
  valuation: string | null
  personalImpact: string | null
  conditionalSuggestion: string | null
  limitations: string[]
  keyJudgments: Array<{ judgment: string; evidence: string[] }>
}

type TraceEntry =
  | { type: 'system_prompt'; content: string; operationId?: string }
  | { type: 'user_input'; content: string; operationId?: string }
  | { type: 'runtime_policy'; settings: RuntimeSettings; operationId?: string }
  | { type: 'model_event'; event: unknown; operationId?: string }
  | {
    type: 'tool_call'; name: string; toolCallId: string
    input: unknown; startedAt: string; operationId: string
  }
  | {
    type: 'tool_result'; name: string; toolCallId: string; result: unknown; isError: boolean
    startedAt: string | null; completedAt: string; completionOrder: number
    notStarted?: boolean; operationId: string
  }
  | { type: 'cancelled'; operationId?: string }
  | {
    type: 'tool_projection'
    projectionId: string
    version: number
    visibleToolNames: string[]
    operationId: string
  }

export type ModelEvent =
  | {
    type: 'lifecycle'
    status: 'running_model' | 'running_tools' | 'waiting_for_specialists'
      | 'finalizing' | 'budget_exhausted'
    operationId: string
    waitTarget?: string
  }
  | { type: 'text_delta'; text: string; operationId?: string }
  | { type: 'trace'; entry: TraceEntry }
  | {
    type: 'completed'
    report: AnalysisReport
    usage?: unknown
    stopReason?: string
    operationId?: string
  }
  | { type: 'cancelled'; operationId?: string }

export type AnalyzeInput = {
  executionId: string
  runtimeSettings: RuntimeSettings
  symbol: string
  systemPrompt: string
  userPrompt: string
  knownFacts: Fact[]
  fetchFinancialContext: (
    symbol: string,
    signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  searchNews?: (
    keyword: string,
    signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  fetchTechnicalIndicators?: (
    symbol: string,
    startDate: string,
    endDate: string,
    signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  signal?: AbortSignal
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime?: ToolRuntime
}

export type ToolRuntime = {
  ensureProjection(input: {
    executionId: string
    role: 'main' | 'fundamental'
    stage: 'research' | 'finalization'
    tools: Tool[]
    createdAt: string
  }): Promise<{ id: string; version: number }>
  recordModelRequest(input: {
    requestId: string
    executionId: string
    projectionId: string
    turnIndex: number
    createdAt: string
  }): Promise<void>
  beginModelRequest(input: {
    requestId: string
    executionId: string
    role: 'main' | 'fundamental'
    stage: 'research' | 'finalization'
    turnIndex: number
    tools: Tool[]
    createdAt: string
  }): Promise<{ id: string; version: number }>
  beginToolBatch(input: {
    id: string
    executionId: string
    projectionId: string
    turnIndex: number
    calls: Array<{
      toolCallId: string
      toolName: string
      position: number
      operationId?: string
      eventPayload?: Record<string, unknown>
    }>
    createdAt: string
  }): Promise<void>
  startToolCall(input: {
    batchId: string
    executionId: string
    toolCallId: string
    startedAt: string
    operationId: string
    eventPayload: Record<string, unknown>
  }): Promise<void>
  completeToolBatch(input: {
    id: string
    executionId: string
    results: Array<{
      toolCallId: string
      toolName: string
      status: 'completed' | 'failed' | 'cancelled'
      startedAt: string | null
      completedAt: string
      completionOrder: number
      result: unknown
      isError: boolean
      operationId: string
    }>
    completedAt: string
  }): Promise<void>
}

export type ModelOptions = {
  modelsFactory?: typeof createModels
  fauxResponses?: FauxResponseStep[]
  fauxTokensPerSecond?: number
  toolTimeoutMs?: number
  log?: (entry: Record<string, unknown>) => void
  provider?: string
  apiProtocol?: 'chat-completions' | 'responses'
  modelName?: string
  baseUrl?: string
  apiKey?: string
  runtimeMinuteMs?: number
  activeNow?: () => number
  activeTimeoutSignal?: (timeoutMs: number) => AbortSignal
}

export function createPiModel(options: ModelOptions = {}) {
  return createProjectedPiModel(options)
}
