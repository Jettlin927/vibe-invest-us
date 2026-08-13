export type FinancialDataHealth = {
  service: 'financial-data'
  status: 'ok'
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
