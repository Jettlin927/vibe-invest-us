export type FinancialDataHealth = {
  service: 'financial-data'
  status: 'ok'
}

export type ModelTokenUsage = {
  input: number | null; cacheRead: number | null; cacheWrite: number | null
  output: number | null; total: number | null
}
export type TokenUsageAggregate = ModelTokenUsage & {
  attempts: number; reportedAttempts: number; coverage: number
}
export function aggregateModelTokenUsage(
  attempts: Array<{ usageStatus: string; usage: ModelTokenUsage }>,
): TokenUsageAggregate {
  const reported = attempts.filter(({ usageStatus }) => usageStatus !== 'unknown')
  const sum = (field: keyof ModelTokenUsage) => (
    reported.length && reported.every((attempt) => attempt.usage[field] !== null)
      ? reported.reduce((total, attempt) => total + attempt.usage[field]!, 0) : null
  )
  return {
    attempts: attempts.length, reportedAttempts: reported.length,
    coverage: attempts.length ? reported.length / attempts.length : 0,
    input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
    output: sum('output'), total: sum('total'),
  }
}

export const agentExecutionStatuses = [
  'planning', 'running_model', 'running_tools', 'waiting_for_specialists',
  'finalizing', 'completed', 'partial', 'failed', 'stopping', 'stopped',
  'interrupted', 'budget_exhausted',
] as const
export type AgentExecutionStatus = typeof agentExecutionStatuses[number]
export const terminalAgentExecutionStatuses = [
  'completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted',
] as const satisfies readonly AgentExecutionStatus[]
export function isTerminalAgentExecutionStatus(
  status: string, terminal?: boolean,
): status is typeof terminalAgentExecutionStatuses[number] {
  if (!terminalAgentExecutionStatuses.includes(status as typeof terminalAgentExecutionStatuses[number])) return false
  return terminal !== false
}
export type WaitReason = {
  kind: 'database' | 'model' | 'tools' | 'specialists' | 'finalizing' | 'runtime'
  target: string
  startedAt: string
}
export function waitReasonForStatus(
  status: AgentExecutionStatus, target: string, startedAt: string,
): WaitReason | null {
  const kind = statusKind[status as keyof typeof statusKind]
  return kind ? { kind, target, startedAt } : null
}
const statusKind = {
  planning: 'database', running_model: 'model', running_tools: 'tools',
  waiting_for_specialists: 'specialists', finalizing: 'finalizing',
  stopping: 'runtime',
} as const

export const defaultRuntimeSettings = {
  mainAgentToolRounds: 20,
  specialistAgentToolRounds: 20,
  researchActiveMinutes: 10,
  executionWallClockMinutes: 45,
  analysisConcurrency: 2,
  modelConcurrency: 4,
  toolConcurrency: 8,
  modelRequestTimeoutMinutes: 15,
  reportFreshnessDays: 7,
  compactionReserveTokens: 16_384,
  agentModeFlat: 0,
  flatAgentToolRounds: 40,
} as const

export type RuntimeSettings = {
  -readonly [Key in keyof typeof defaultRuntimeSettings]: number
}

export type RuntimeSettingsRevision = {
  id: number
  values: RuntimeSettings
  createdAt: string
}

export type ExecutionSettingsSnapshot = RuntimeSettingsRevision & {
  executionId: string
}

export type RuntimeSettingsResponse = {
  model: { configured: boolean }
  current: RuntimeSettingsRevision
  defaults: RuntimeSettings
  activeExecutions: ExecutionSettingsSnapshot[]
}

export const runtimeSettingLimits: Record<keyof RuntimeSettings, readonly [number, number]> = {
  mainAgentToolRounds: [1, 500],
  specialistAgentToolRounds: [1, 500],
  researchActiveMinutes: [1, 240],
  executionWallClockMinutes: [1, 240],
  analysisConcurrency: [1, 16],
  modelConcurrency: [1, 32],
  toolConcurrency: [1, 64],
  modelRequestTimeoutMinutes: [1, 60],
  reportFreshnessDays: [1, 365],
  compactionReserveTokens: [1, 1_000_000],
  agentModeFlat: [0, 1],
  flatAgentToolRounds: [1, 500],
}

export function parseRuntimeSettingsUpdate(value: unknown): Partial<RuntimeSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_runtime_settings_update')
  }
  const input = value as Record<string, unknown>
  const entries = Object.entries(input)
  if (!entries.length) throw new Error('runtime_settings_update_empty')
  const result: Partial<RuntimeSettings> = {}
  for (const [key, setting] of entries) {
    if (!(key in runtimeSettingLimits)) throw new Error(`unknown_runtime_setting:${key}`)
    const typedKey = key as keyof RuntimeSettings
    const [minimum, maximum] = runtimeSettingLimits[typedKey]
    if (typeof setting !== 'number' || !Number.isInteger(setting)
      || setting < minimum || setting > maximum) {
      throw new Error(`invalid_runtime_setting:${key}`)
    }
    result[typedKey] = setting
  }
  return result
}

export function isRuntimeSettingsResponse(value: unknown): value is RuntimeSettingsResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const model = candidate.model
  const current = candidate.current
  return !!model && typeof model === 'object'
    && typeof (model as Record<string, unknown>).configured === 'boolean'
    && isRuntimeSettingsRevision(current)
    && isRuntimeSettings(candidate.defaults)
    && Array.isArray(candidate.activeExecutions)
    && candidate.activeExecutions.every((snapshot) => (
      isRuntimeSettingsRevision(snapshot)
      && typeof (snapshot as Record<string, unknown>).executionId === 'string'
    ))
}

function isRuntimeSettingsRevision(value: unknown): value is RuntimeSettingsRevision {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return Number.isInteger(candidate.id)
    && typeof candidate.createdAt === 'string'
    && isRuntimeSettings(candidate.values)
}

function isRuntimeSettings(value: unknown): value is RuntimeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(runtimeSettingLimits)
  return Object.keys(candidate).length === keys.length && keys.every((key) => {
    const setting = candidate[key]
    const [minimum, maximum] = runtimeSettingLimits[key as keyof RuntimeSettings]
    return typeof setting === 'number' && Number.isInteger(setting)
      && setting >= minimum && setting <= maximum
  })
}

export type SystemHealth = {
  service: 'analysis-api'
  status: 'ok'
  dependencies: {
    productDatabase: { status: 'ok'; engine: 'postgresql'; schemaVersion: number }
    financialData: FinancialDataHealth
  }
}

export type WatchlistItem = {
  symbol: string
  note: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export const trackingTargetSources = ['watchlist', 'position'] as const
export type TrackingTargetSource = typeof trackingTargetSources[number]

export type TrackingTarget = {
  symbol: string
  sources: TrackingTargetSource[]
}

export const trackingRunStatuses = ['running', 'completed', 'partial', 'failed'] as const
export type TrackingRunStatus = typeof trackingRunStatuses[number]

export type TrackingRun = {
  id: string
  status: TrackingRunStatus
  targets: TrackingTarget[]
  startedAt: string
  completedAt: string | null
  error: string | null
}

export const trackingCapabilities = ['technical', 'fundamental', 'news'] as const
export type TrackingCapability = typeof trackingCapabilities[number]

export const trackingObservationStatuses = ['success', 'data_gap'] as const
export type TrackingObservationStatus = typeof trackingObservationStatuses[number]

export type TrackingObservation = {
  id: string
  runId: string
  symbol: string
  capability: TrackingCapability
  status: TrackingObservationStatus
  baselineObservationId: string | null
  observedAt: string
  payload: Record<string, unknown>
}

export const profitProtectionRules = [
  'thesis_invalidation', 'position_changed', 'max_weight', 'earnings_window',
  'first_take_profit', 'second_take_profit', 'activate_trailing', 'trailing_stop',
] as const
export type ProfitProtectionRule = typeof profitProtectionRules[number]
export const profitProtectionLadderRules = [
  'first_take_profit', 'second_take_profit', 'activate_trailing',
] as const satisfies readonly ProfitProtectionRule[]
export type ProfitProtectionLadderRule = typeof profitProtectionLadderRules[number]

export const profitProtectionStatuses = [
  'normal', 'triggered', 'review_required', 'data_gap',
] as const
export type ProfitProtectionStatusName = typeof profitProtectionStatuses[number]

export type ProfitProtectionStatus = {
  symbol: string
  status: ProfitProtectionStatusName
  planRevision: number
  currentR: number | null
  bindingRule: ProfitProtectionRule | null
  nextRule: { kind: ProfitProtectionLadderRule; atR: number } | null
  coreRatio: number
  tradingRatio: number
  anchorPrice: number
  invalidationPrice: number
  maxPortfolioWeight: number
  marketPrice: number | null
  portfolioWeight: number | null
  levels: { firstTakeProfit: number; secondTakeProfit: number; trailingStart: number }
  earnings?: { date: string; riskStartsAt: string; inRiskWindow: boolean }
  trailing?: { active: boolean; ema20: number | null; observedAt: string; peakPrice: number | null }
  profitJourney?: {
    peakUnrealizedProfit: number; currentUnrealizedProfit: number
    givebackAmount: number; givebackRatio: number | null
  }
}

export type ProfitProtectionTrigger = {
  id: string
  symbol: string
  rule: ProfitProtectionRule
  status: 'open' | 'acknowledged'
  triggeredAt: string
  acknowledgedAt: string | null
}

export type ProfitProtectionOverview = {
  summary: { planned: number; triggered: number; reviewRequired: number; dataGap: number }
  positions: ProfitProtectionStatus[]
  triggers: ProfitProtectionTrigger[]
}

export function isProfitProtectionOverview(value: unknown): value is ProfitProtectionOverview {
  if (!isRecord(value) || !isRecord(value.summary)
    || !Array.isArray(value.positions) || !Array.isArray(value.triggers)) return false
  const summary = value.summary
  if (!['planned', 'triggered', 'reviewRequired', 'dataGap']
    .every((key) => nonNegativeInteger(summary[key]))) return false
  return value.positions.every(isProfitProtectionStatus)
    && value.triggers.every((trigger) => isRecord(trigger)
      && typeof trigger.id === 'string' && typeof trigger.symbol === 'string'
      && profitProtectionRules.includes(trigger.rule as ProfitProtectionRule)
      && (trigger.status === 'open' || trigger.status === 'acknowledged')
      && typeof trigger.triggeredAt === 'string'
      && (trigger.acknowledgedAt === null || typeof trigger.acknowledgedAt === 'string'))
}

function isProfitProtectionStatus(value: unknown): value is ProfitProtectionStatus {
  if (!isRecord(value) || typeof value.symbol !== 'string'
    || !profitProtectionStatuses.includes(value.status as ProfitProtectionStatusName)
    || !Number.isInteger(value.planRevision)
    || !nullableFiniteNumber(value.currentR)
    || !(value.bindingRule === null
      || profitProtectionRules.includes(value.bindingRule as ProfitProtectionRule))
    || !isRecord(value.levels)) return false
  const numbers = [
    value.coreRatio, value.tradingRatio, value.anchorPrice,
    value.invalidationPrice, value.maxPortfolioWeight,
  ]
  const nullableNumbers = [value.marketPrice, value.portfolioWeight]
  const levels = value.levels
  return numbers.every(finiteNumber) && nullableNumbers.every(nullableFiniteNumber)
    && ['firstTakeProfit', 'secondTakeProfit', 'trailingStart']
      .every((key) => finiteNumber(levels[key]))
    && (value.nextRule === null || (isRecord(value.nextRule)
      && profitProtectionLadderRules.includes(value.nextRule.kind as ProfitProtectionLadderRule)
      && finiteNumber(value.nextRule.atR)))
    && validEarnings(value.earnings)
    && validTrailing(value.trailing)
    && validProfitJourney(value.profitJourney)
}

function validEarnings(value: unknown) {
  return value === undefined || (isRecord(value)
    && typeof value.date === 'string' && typeof value.riskStartsAt === 'string'
    && typeof value.inRiskWindow === 'boolean')
}

function validTrailing(value: unknown) {
  return value === undefined || (isRecord(value)
    && typeof value.active === 'boolean' && nullableFiniteNumber(value.ema20)
    && typeof value.observedAt === 'string' && nullableFiniteNumber(value.peakPrice))
}

function validProfitJourney(value: unknown) {
  return value === undefined || (isRecord(value)
    && finiteNumber(value.peakUnrealizedProfit)
    && finiteNumber(value.currentUnrealizedProfit)
    && finiteNumber(value.givebackAmount)
    && nullableFiniteNumber(value.givebackRatio))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

export const trackingEventSeverities = ['info', 'warning', 'critical'] as const
export type TrackingEventSeverity = typeof trackingEventSeverities[number]

export type TrackingEventCandidate = {
  eventKey: string
  kind: string
  severity: TrackingEventSeverity
  occurredAt: string
  payload: Record<string, unknown>
}

export type TrackingEvent = TrackingEventCandidate & {
  id: string
  runId: string
  observationId: string
  baselineObservationId: string
  symbol: string
  capability: TrackingCapability
  createdAt: string
}

export type TrackingRunDetail = TrackingRun & {
  observations: TrackingObservation[]
  events: TrackingEvent[]
}

export type TrackingObservationInput = {
  id: string
  symbol: string
  capability: TrackingCapability
  status: TrackingObservationStatus
  observedAt: string
  payload: Record<string, unknown>
  events: TrackingEventCandidate[]
}

export type SseEventEnvelope = {
  id: string
  event: string
  data: Record<string, unknown>
}

export function formatSseEvent(event: SseEventEnvelope) {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export function isFinancialDataHealth(value: unknown): value is FinancialDataHealth {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate.service === 'financial-data' && candidate.status === 'ok'
}

export function isSystemHealth(value: unknown): value is SystemHealth {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const dependencies = candidate.dependencies
  if (!dependencies || typeof dependencies !== 'object') return false
  const dependencyValues = dependencies as Record<string, unknown>
  const database = dependencyValues.productDatabase
  return candidate.service === 'analysis-api'
    && candidate.status === 'ok'
    && !!database
    && typeof database === 'object'
    && (database as Record<string, unknown>).status === 'ok'
    && (database as Record<string, unknown>).engine === 'postgresql'
    && typeof (database as Record<string, unknown>).schemaVersion === 'number'
    && isFinancialDataHealth(dependencyValues.financialData)
}

/**
 * A durable user-facing conversation.  Research is one capability that can
 * own a conversation; the runtime itself does not assume a fixed workflow.
 */
export type ConversationThread = {
  id: string
  capability: string
  parentThreadId?: string | null
  title: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  createdAt: string
  updatedAt: string
  sessionId: string
  executionId: string
}

export type ConversationRun = {
  threadId: string
  sessionId: string
  executionId: string
  generation: number
  status: AgentExecutionStatus
  created: boolean
}
