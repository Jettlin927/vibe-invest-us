export type FinancialDataHealth = {
  service: 'financial-data'
  status: 'ok'
}

export type SystemHealth = {
  service: 'analysis-api'
  status: 'ok'
  dependencies: {
    productDatabase: { status: 'ok'; engine: 'postgresql'; schemaVersion: number }
    financialData: FinancialDataHealth
  }
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
