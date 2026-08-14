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
    if (prohibitedCapability(name)) invalid(name, 'prohibited_capability')
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
    if (definition.hostAccess !== 'none') invalid(name, 'host_access')
    if (!oneOf(definition.resultRetention, ['research_record', 'report_version'])) invalid(name, 'result_retention')
    if (!oneOf(definition.modelProjection, ['full_result', 'bounded_summary', 'acknowledgement'])) {
      invalid(name, 'model_projection')
    }
    if (!oneOf(definition.executionMode, ['sequential', 'parallel'])) invalid(name, 'execution_mode')
    if (typeof definition.countsAsToolRound !== 'boolean') invalid(name, 'round_behavior')
    if (!validReportPolicy(definition)) invalid(name, 'report_policy')
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
    projectResult(name: string, result: Record<string, unknown>) {
      const projection = validated.find((definition) => definition.model.name === name)?.modelProjection
      if (projection === 'full_result') return result
      if (projection === 'acknowledgement') {
        if (['submit_analysis_report', 'submit_specialist_report'].includes(name)) {
          return projectReportSubmission(result)
        }
        return { submitted: result.submitted === true, ...(result.error ? { error: result.error } : {}) }
      }
      if (result.modelProjection && typeof result.modelProjection === 'object') {
        return result.modelProjection as Record<string, unknown>
      }
      return selectResult(result, boundedResultKeys)
    },
    projectPublicResult(name: string, result: Record<string, unknown>) {
      if (!validated.some((definition) => definition.model.name === name)) return {}
      return projectPublicToolResult(name, result)
    },
  })
}

const boundedResultKeys = [
  'facts', 'gaps', 'summary', 'analysis', 'error', 'source', 'sources',
  'launched', 'status', 'sessionId', 'executionId', 'reportId', 'reportVersion',
  'keyFactIds', 'contraryFactIds',
  'cursor', 'nextCursor', 'pagination', 'truncated', 'resultCount',
  'returnedCount', 'totalCount', 'items', 'overview',
  'symbol', 'authorizedComparables', 'comparables',
  'currentMultiples', 'historicalRanges', 'methods',
  'actualStart', 'actualEnd', 'totalBarCount', 'sampling', 'structures',
  'indicators', 'volatility', 'drawdown', 'volumePrice', 'keyLevels', 'conflicts',
]

function selectResult(result: Record<string, unknown>, allowed: string[]) {
  return Object.fromEntries(allowed.flatMap((key) => key in result ? [[key, result[key]]] : []))
}

function projectPublicToolResult(name: string, result: Record<string, unknown>) {
  const common = projectCommonResult(result)
  if (['fetch_financial_context', 'search_news_candidates', 'search_web_evidence',
    'read_news_document', 'list_company_events'].includes(name)) return common
  if (name === 'get_financial_overview') return {
    ...common, ...optionalObject('overview', projectFinancialOverview(result.overview)),
  }
  if (name === 'get_financial_metric_series') return { ...common, ...projectPagination(result) }
  if (name === 'read_filing_document') return {
    ...common, ...projectPagination(result),
    ...optionalArray('items', result.items, projectFilingItem),
  }
  if (name === 'get_valuation_evidence') return {
    ...common,
    ...selectTyped(result, ['symbol'], 'string'),
    ...optionalArray('authorizedComparables', result.authorizedComparables, stringValue),
    ...optionalArray('comparables', result.comparables, projectComparable),
    ...optionalObject('currentMultiples', projectNumericRecord(result.currentMultiples)),
    ...optionalObject('historicalRanges', projectNumericRangeRecord(result.historicalRanges)),
    ...optionalObject('methods', projectValuationMethods(result.methods)),
  }
  if (name === 'get_technical_evidence') return {
    ...common, ...selectTyped(result, ['symbol', 'actualStart', 'actualEnd'], 'string'),
    ...selectTyped(result, ['totalBarCount'], 'number'),
    ...optionalObject('structures', projectTechnicalStructures(result.structures)),
    ...optionalObject('indicators', projectIndicators(result.indicators)),
    ...optionalObject('volatility', selectTyped(record(result.volatility), ['annualized'], 'number')),
    ...optionalObject('drawdown', selectTyped(record(result.drawdown), ['maximum'], 'number')),
    ...optionalObject('volumePrice', selectTyped(
      record(result.volumePrice), ['volumeRatio5To20'], 'number',
    )),
    ...optionalObject('keyLevels', selectTyped(
      record(result.keyLevels), ['support', 'resistance'], 'number',
    )),
    ...optionalArray('conflicts', result.conflicts, stringValue),
  }
  if (name === 'get_price_window') return {
    ...common, ...projectPagination(result),
    ...selectTyped(result, ['symbol', 'actualStart', 'actualEnd', 'sampling'], 'string'),
    ...selectTyped(result, ['totalBarCount'], 'number'),
  }
  if (['run_news_analysis', 'run_fundamental_analysis', 'run_technical_analysis'].includes(name)) {
    return projectSpecialistResult(result)
  }
  if (['submit_analysis_report', 'submit_specialist_report'].includes(name)) {
    return projectReportSubmission(result)
  }
  return {}
}

function projectCommonResult(result: Record<string, unknown>) {
  return {
    ...optionalArray('facts', result.facts, identity),
    ...optionalArray('gaps', result.gaps, projectGap),
    ...selectTyped(result, ['summary', 'error', 'source'], 'string'),
    ...optionalArray('sources', result.sources, projectSource),
  }
}

function projectFinancialOverview(value: unknown) {
  const overview = record(value)
  return {
    ...selectTyped(overview, ['symbol', 'latestPeriod'], 'string'),
    ...optionalArray('qualityFlags', overview.qualityFlags, (entry) => selectTyped(
      record(entry), ['flag_type', 'severity', 'period'], 'string',
    )),
  }
}

function projectPagination(result: Record<string, unknown>) {
  return {
    ...selectTyped(result, ['cursor', 'nextCursor'], 'string'),
    ...selectTyped(result, ['returnedCount', 'totalCount', 'resultCount'], 'number'),
    ...selectTyped(result, ['truncated'], 'boolean'),
  }
}

function projectFilingItem(value: unknown) {
  const item = record(value)
  return {
    ...selectTyped(item, ['name', 'summary', 'contentHash'], 'string'),
    ...selectTyped(item, ['startByte', 'endByte'], 'number'),
  }
}

function projectComparable(value: unknown) {
  const comparable = record(value)
  return {
    ...selectTyped(comparable, ['symbol'], 'string'),
    ...selectTyped(comparable, ['pe', 'evToEbitda', 'evToRevenue'], 'number'),
  }
}

function projectNumericRecord(value: unknown) {
  return selectTyped(record(value), ['pe', 'evToEbitda', 'evToRevenue'], 'number')
}

function projectNumericRangeRecord(value: unknown) {
  const source = record(value)
  return Object.fromEntries(['pe', 'evToEbitda', 'evToRevenue'].flatMap((key) => {
    const range = Array.isArray(source[key])
      ? source[key].filter((entry) => typeof entry === 'number' && Number.isFinite(entry)) : []
    return range.length ? [[key, range]] : []
  }))
}

function projectValuationMethods(value: unknown) {
  const source = record(value)
  const names = ['dcf', 'nav', 'pFfo', 'rNpv', 'pe', 'evToEbitda', 'evToRevenue', 'industry']
  return Object.fromEntries(names.flatMap((name) => {
    if (!source[name] || typeof source[name] !== 'object') return []
    const method = record(source[name])
    return [[name, {
      ...selectTyped(method, ['status', 'reason'], 'string'),
      ...selectTyped(method, ['multiple', 'targetPrice', 'multiplePercentile'], 'number'),
      ...optionalObject('range', selectTyped(record(method.range), ['low', 'high'], 'number')),
    }]]
  }))
}

function projectTechnicalStructures(value: unknown) {
  const source = record(value)
  return Object.fromEntries(['20d', '60d', '120d', '252d'].flatMap((window) => {
    if (!source[window] || typeof source[window] !== 'object') return []
    const structure = record(source[window])
    return [[window, {
      ...selectTyped(structure, ['status', 'reason'], 'string'),
      ...selectTyped(structure, ['barCount', 'returnPct', 'high', 'low'], 'number'),
    }]]
  }))
}

function projectIndicators(value: unknown) {
  const indicators = record(value)
  return {
    ...selectTyped(indicators, [
      'ma_5', 'ma_20', 'rsi_14', 'annualized_volatility', 'max_drawdown',
      'volume_ratio_5_to_20',
    ], 'number'),
    ...optionalObject('macd', selectTyped(
      record(indicators.macd), ['line', 'signal', 'histogram'], 'number',
    )),
  }
}

function projectSpecialistResult(result: Record<string, unknown>) {
  return {
    ...selectTyped(result, [
      'status', 'sessionId', 'executionId', 'reportId', 'summary', 'researchQuestion',
      'reason', 'domain',
    ], 'string'),
    ...selectTyped(result, ['reportVersion'], 'number'),
    ...selectTyped(result, ['launched'], 'boolean'),
    ...optionalArray('keyFactIds', result.keyFactIds, stringValue),
    ...optionalArray('contraryFactIds', result.contraryFactIds, stringValue),
    ...optionalArray('gaps', result.gaps, projectGap),
    ...optionalObject('targetPrice', projectTargetPrice(result.targetPrice)),
  }
}

function projectTargetPrice(value: unknown) {
  const target = record(value)
  return {
    ...selectTyped(target, ['method', 'asOf'], 'string'),
    ...optionalArray('inputs', target.inputs, stringValue),
    ...optionalArray('evidence', target.evidence, stringValue),
    ...optionalObject('range', selectTyped(record(target.range), ['low', 'high'], 'number')),
  }
}

function projectReportSubmission(result: Record<string, unknown>) {
  return {
    submitted: result.submitted === true,
    ...selectTyped(result, ['mustChangeCandidate'], 'boolean'),
    ...selectTyped(result, ['error', 'candidatePayloadHash'], 'string'),
    ...optionalArray('errors', result.errors, (entry) => {
      const error = record(entry)
      return {
        ...selectTyped(error, ['path', 'rule', 'message'], 'string'),
        ...optionalArray('allowedEvidenceTypes', error.allowedEvidenceTypes, stringValue),
      }
    }),
    ...optionalArray('repairInstructions', result.repairInstructions, (entry) => {
      const instruction = record(entry)
      return {
        ...selectTyped(instruction, ['path', 'action', 'instruction'], 'string'),
        ...optionalArray(
          'allowedEvidenceTypes', instruction.allowedEvidenceTypes, stringValue,
        ),
      }
    }),
    ...optionalArray('facts', result.facts, identity),
  }
}

function projectGap(value: unknown) {
  return selectTyped(record(value), ['capability', 'reason', 'impact'], 'string')
}

function projectSource(value: unknown) {
  const source = record(value)
  return {
    ...selectTyped(source, ['source', 'status', 'error'], 'string'),
    ...selectTyped(source, ['item_count', 'itemCount'], 'number'),
  }
}

function selectTyped(
  value: Record<string, unknown>, keys: string[], type: 'string' | 'number' | 'boolean',
) {
  return Object.fromEntries(keys.flatMap((key) => {
    const candidate = value[key]
    if (typeof candidate !== type) return []
    if (type === 'number' && !Number.isFinite(candidate)) return []
    return [[key, candidate]]
  }))
}

function optionalObject(key: string, value: Record<string, unknown>) {
  return Object.keys(value).length ? { [key]: value } : {}
}

function optionalArray(
  key: string, value: unknown, projector: (entry: unknown) => unknown,
) {
  return Array.isArray(value) ? { [key]: value.map(projector).filter((entry) => entry !== undefined) } : {}
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined }
function identity(value: unknown) { return value }

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

function prohibitedCapability(name: string) {
  return /(^|_)(shell|bash|terminal|exec|command|filesystem)(_|$)/i.test(name)
    || /(^|_)(read|write|delete|list)_files?(_|$)/i.test(name)
}

function validReportPolicy(definition: RegisteredToolDefinition) {
  if (definition.sideEffect !== 'creates_report') {
    return definition.resultRetention !== 'report_version'
      && definition.modelProjection !== 'acknowledgement'
  }
  const name = definition.model.name
  const expectedRoles: ToolRole[] = name === 'submit_analysis_report' ? ['main']
    : name === 'submit_specialist_report' ? ['fundamental', 'news', 'technical'] : []
  return expectedRoles.length > 0
    && definition.allowedRoles.length === expectedRoles.length
    && expectedRoles.every((role) => definition.allowedRoles.includes(role))
    && definition.externalNetwork === 'none'
    && definition.resultRetention === 'report_version'
    && definition.modelProjection === 'acknowledgement'
    && definition.executionMode === 'sequential'
}

function invalid(name: string, field: string): never {
  throw new Error(`tool_registry_invalid:${field}:${name}`)
}

export const toolRegistry = createToolRegistry(registeredToolDefinitions, registeredToolHandlers)
