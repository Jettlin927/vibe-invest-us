import AjvModule from 'ajv'
import addFormatsModule from 'ajv-formats'

import { fetchFinancialContextDefinition } from './tool-definitions/fetch-financial-context.js'
import { getFinancialMetricSeriesDefinition } from './tool-definitions/get-financial-metric-series.js'
import { getFinancialOverviewDefinition } from './tool-definitions/get-financial-overview.js'
import { getValuationEvidenceDefinition } from './tool-definitions/get-valuation-evidence.js'
import { getTechnicalEvidenceDefinition } from './tool-definitions/get-technical-evidence.js'
import { getPriceWindowDefinition } from './tool-definitions/get-price-window.js'
import { listCompanyEventsDefinition } from './tool-definitions/list-company-events.js'
import { readNewsDocumentDefinition } from './tool-definitions/read-news-document.js'
import { readFilingDocumentDefinition } from './tool-definitions/read-filing-document.js'
import { runNewsAnalysisDefinition } from './tool-definitions/run-news-analysis.js'
import { runFundamentalAnalysisDefinition } from './tool-definitions/run-fundamental-analysis.js'
import { runTechnicalAnalysisDefinition } from './tool-definitions/run-technical-analysis.js'
import { searchNewsCandidatesDefinition } from './tool-definitions/search-news-candidates.js'
import { searchWebEvidenceDefinition } from './tool-definitions/search-web-evidence.js'
import { submitSpecialistReportDefinition } from './tool-definitions/submit-specialist-report.js'
import { submitAnalysisReportDefinition } from './tool-definitions/submit-analysis-report.js'
import type {
  RegisteredToolDefinition, ToolRole, ToolStage,
} from './tool-definitions/types.js'
import { registeredToolHandlers, type RegisteredToolHandler } from './tool-handlers.js'

export type { RegisteredToolDefinition } from './tool-definitions/types.js'
export { registeredToolHandlers } from './tool-handlers.js'

export const registeredToolDefinitions = [
  fetchFinancialContextDefinition,
  runFundamentalAnalysisDefinition,
  runNewsAnalysisDefinition,
  runTechnicalAnalysisDefinition,
  submitAnalysisReportDefinition,
  getFinancialOverviewDefinition,
  getFinancialMetricSeriesDefinition,
  getValuationEvidenceDefinition,
  getTechnicalEvidenceDefinition,
  getPriceWindowDefinition,
  readFilingDocumentDefinition,
  searchNewsCandidatesDefinition,
  searchWebEvidenceDefinition,
  readNewsDocumentDefinition,
  listCompanyEventsDefinition,
  submitSpecialistReportDefinition,
]

export function createToolRegistry(
  definitions: RegisteredToolDefinition[], handlers: Record<string, RegisteredToolHandler>,
) {
  const names = new Set<string>()
  const validated = definitions.map((definition) => {
    const name = definition.model?.name
    if (!name || names.has(name)) invalid(name || 'unknown', 'duplicate_name')
    names.add(name)
    if (!validSchema(definition.model.parameters)) invalid(name, 'parameters_schema')
    if (!validSchema(definition.resultSchema)) invalid(name, 'result_schema')
    if (typeof handlers[name] !== 'function') invalid(name, 'handler')
    if (!definition.allowedRoles?.length
      || !definition.allowedRoles.every((role) => oneOf(role, ['main', 'fundamental', 'news', 'technical']))) {
      invalid(name, 'allowed_roles')
    }
    if (!definition.allowedStages?.length
      || !definition.allowedStages.every((stage) => oneOf(stage, ['research', 'finalization']))) {
      invalid(name, 'allowed_stages')
    }
    if (!oneOf(definition.sideEffect, ['read_only', 'creates_report'])) invalid(name, 'side_effect')
    if (!oneOf(definition.externalNetwork, ['none', 'financial_data'])) invalid(name, 'external_network')
    if (!oneOf(definition.resultRetention, ['research_record', 'report_version'])) invalid(name, 'result_retention')
    if (!oneOf(definition.modelProjection, ['full_result', 'bounded_summary', 'acknowledgement'])) {
      invalid(name, 'model_projection')
    }
    if (!oneOf(definition.executionMode, ['sequential', 'parallel'])) invalid(name, 'execution_mode')
    if (typeof definition.countsAsToolRound !== 'boolean') invalid(name, 'round_behavior')
    return Object.freeze({ ...definition })
  })
  return Object.freeze({
    list: () => [...validated],
    project: ({ role, stage }: { role: ToolRole; stage: ToolStage }) => validated
      .filter((definition) => definition.allowedRoles.includes(role)
        && definition.allowedStages.includes(stage))
      .map((definition) => definition.model),
    definition: (name: string) => validated.find((definition) => definition.model.name === name),
    handler: (name: string) => handlers[name],
  })
}

function validSchema(value: unknown) {
  if (!value || typeof value !== 'object') return false
  try {
    const schema = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    if (!('type' in schema) && !('anyOf' in schema) && !('$ref' in schema)) return false
    const Ajv = AjvModule as unknown as new (options?: object) => { compile(schema: object): unknown }
    const addFormats = addFormatsModule as unknown as <T>(ajv: T) => T
    addFormats(new Ajv({ strict: true })).compile(schema)
    return true
  } catch { return false }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}

function invalid(name: string, field: string): never {
  throw new Error(`tool_registry_invalid:${field}:${name}`)
}

export const toolRegistry = createToolRegistry(registeredToolDefinitions, registeredToolHandlers)
