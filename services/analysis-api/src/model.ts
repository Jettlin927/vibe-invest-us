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
  evidenceLevel?: string
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
  | { type: 'runtime_context'; content: RuntimeContext; operationId?: string }
  | { type: 'runtime_resume'; content: RuntimeResume; operationId?: string }
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
  | {
    type: 'web_search_eligibility'; query: string; eligible: boolean
    reasons: Array<{ source: string; reason: string }>; operationId: string
  }
  | {
    type: 'runtime_turn_advanced'; toolRounds: number; activeElapsedMs: number
    stage: 'research' | 'finalization'; operationId: string
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
    reportVersion?: {
      kind: 'integrated' | 'specialist'
      report: Record<string, unknown>
    }
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
  userPrompt?: string
  runtimeContext?: RuntimeContext
  runtimeResume?: RuntimeResume
  knownFacts: Fact[]
  refreshKnownFacts?: () => Promise<Fact[]>
  finalizationOnly?: boolean
  priorSpecialistOutcomes?: Array<{
    domain: 'news' | 'fundamental_valuation' | 'technical'
    outcome: Record<string, unknown>
  }>
  onSpecialistOutcome?: (
    domain: 'news' | 'fundamental_valuation' | 'technical', outcome: Record<string, unknown>,
  ) => void
  fetchFinancialContext: (
    symbol: string,
    signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  financialContextToolViews?: FinancialContextToolViews
  prepareSpecialistBatch?: (requests: Array<{
    domain: 'news' | 'fundamental_valuation' | 'technical'
    researchQuestion: string
    reason: string
  }>, batchId: string) => Promise<Array<{
    domain: 'news' | 'fundamental_valuation' | 'technical'
    sessionId: string
    executionId: string
    created: boolean
  }>>
  runNewsSpecialist?: (input: {
    launch: boolean
    researchQuestion: string
    reason: string
    prepared?: { sessionId: string; executionId: string; created: boolean }
  }) => Promise<Record<string, unknown>>
  runFundamentalSpecialist?: (input: {
    launch: boolean
    researchQuestion: string
    reason: string
    prepared?: { sessionId: string; executionId: string; created: boolean }
  }) => Promise<Record<string, unknown>>
  runTechnicalSpecialist?: (input: {
    launch: boolean
    researchQuestion: string
    reason: string
    prepared?: { sessionId: string; executionId: string; created: boolean }
  }) => Promise<Record<string, unknown>>
  signal?: AbortSignal
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime?: ToolRuntime
}

export type AnalyzeNewsInput = {
  executionId: string
  runtimeSettings: RuntimeSettings
  symbol: string
  systemPrompt: string
  researchQuestion: string
  runtimeResume?: RuntimeResume
  knownFacts: Fact[]
  searchNewsCandidates: (
    query: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  searchWebEvidence?: (
    query: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  readNewsDocument: (
    candidate: Fact, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  listCompanyEvents: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  signal?: AbortSignal
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime: ToolRuntime
}

export type AnalyzeFundamentalInput = {
  executionId: string
  runtimeSettings: RuntimeSettings
  symbol: string
  systemPrompt: string
  researchQuestion: string
  runtimeResume?: RuntimeResume
  knownFacts: Fact[]
  getFinancialOverview: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  getFinancialMetricSeries: (
    symbol: string, metric: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  getValuationEvidence: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  readFilingDocument: (
    symbol: string, filingId: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  listCompanyEvents: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  signal?: AbortSignal
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime: ToolRuntime
}

export type AnalyzeTechnicalInput = {
  executionId: string
  runtimeSettings: RuntimeSettings
  symbol: string
  systemPrompt: string
  researchQuestion: string
  runtimeResume?: RuntimeResume
  knownFacts: Fact[]
  getTechnicalEvidence: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  getPriceWindow: (
    symbol: string, startDate: string, endDate: string,
    cursor: string | undefined, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  signal?: AbortSignal
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime: ToolRuntime
}

export type FinancialContextToolViews = {
  model: { facts: Fact[]; [key: string]: unknown }
  retained: { facts: Fact[]; [key: string]: unknown }
}

export type RuntimeContext = {
  role: 'runtime_context'
  generatedBy: 'product_runtime'
  isUserInput: false
  content: Record<string, unknown>
}

export type RuntimeResume = {
  role: 'runtime_resume'
  generatedBy: 'product_runtime'
  isUserInput: false
  content: Record<string, unknown> & {
    reusableToolResults?: Array<{
      toolName: string
      factIds: string[]
      modelProjection: Record<string, unknown>
    }>
  }
}

export type ToolRuntime = {
  ensureProjection(input: {
    executionId: string
    role: 'main' | 'fundamental' | 'news' | 'technical'
    stage: 'research' | 'finalization'
    tools: Tool[]
    createdAt: string
    causativeEvent?: { operationId: string; payload: Record<string, unknown> }
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
    role: 'main' | 'fundamental' | 'news' | 'technical'
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
    advance?: {
      role: 'main' | 'fundamental' | 'news' | 'technical'
      stage: 'research' | 'finalization'
      tools: Tool[]
      toolRounds: number
      activeElapsedMs: number
      causativeEvent?: { operationId: string; payload: Record<string, unknown> }
    }
  }): Promise<{ projection?: { id: string; version: number } }>
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
