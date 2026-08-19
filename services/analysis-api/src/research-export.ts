import { toolRegistry } from './tool-registry.js'

const publicHiddenKeys = new Set([
  'apikey', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'setcookie',
  'token', 'secret', 'clientsecret', 'password', 'credential', 'credentials',
  'providerraw', 'rawprovider', 'rawresponse', 'rawrequest', 'rawpayload', 'rawbody',
  'providerrequest', 'providerresponse', 'privatediagnostic', 'diagnosticraw',
  'reasoning', 'thinking', 'chainofthought', 'thinkingsignature', 'fulltext',
  'copyrightfulltext', 'documentbody', 'rawhtml', 'excerpt', 'modelprojection',
])

const exportHiddenKeys = new Set([
  ...publicHiddenKeys, 'generation', 'operationid', 'previousexecutionid', 'sourceexecutionids',
  'fencetoken', 'fencedsessions', 'cancelledtoolevents',
])

const exportedTraceTypes = new Set([
  'user_input', 'runtime_follow_up', 'chat_completed', 'text_delta', 'model_event',
  'model_completed', 'tool_call', 'tool_result', 'status', 'compaction', 'context_usage',
  'financial_context',
])

export function projectResearchExport(value: unknown) {
  const research = record(value)
  const reportVersions = array(research.reportVersions)
  const specialistAgents = array(research.specialistAgents)
  return {
    schemaVersion: 1,
    analysis: sanitize(select(research, [
      'id', 'symbol', 'status', 'createdAt', 'updatedAt', 'reportCreatedAt',
      'starred', 'note', 'error',
    ]), exportHiddenKeys),
    snapshot: sanitize(research.snapshot, exportHiddenKeys),
    facts: sanitize(array(research.facts), exportHiddenKeys),
    reportVersions: sanitize(reportVersions, exportHiddenKeys),
    specialistReports: sanitize(specialistAgents.flatMap((agent) => {
      const candidate = record(agent)
      return candidate.reportVersion ? [candidate.reportVersion] : []
    }), exportHiddenKeys),
    configurationVersions: sanitize(array(research.configurationVersions), exportHiddenKeys),
    trace: sanitize(array(research.trace).filter((entry) => (
      exportedTraceTypes.has(String(record(entry).type ?? ''))
    )), exportHiddenKeys),
  }
}

export function projectResearchView<T>(value: T): T {
  return sanitize(value, publicHiddenKeys) as T
}

function sanitize(value: unknown, hidden: Set<string>, field = ''): unknown {
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, textLimit(field))
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, hidden, field))
  if (!value || typeof value !== 'object') return value
  const projected = projectStructuredValue(record(value), hidden)
  return Object.fromEntries(Object.entries(projected).flatMap(([key, entry]) => (
    hidden.has(normalizeKey(key)) ? [] : [[key, sanitize(entry, hidden, key)]]
  )))
}

function projectStructuredValue(value: Record<string, unknown>, hidden: Set<string>) {
  if (isFact(value)) return {
    ...select(value, ['id', 'type', 'observedAt', 'fetchedAt', 'source', 'evidenceLevel']),
    ...optionalValue('sourceReference', publicSourceReference(value.sourceReference)),
    value: publicFactValue(value),
  }
  const modelEventType = record(value.event).type
  if (value.type === 'model_event' && typeof modelEventType === 'string'
    && normalizeKey(modelEventType).endsWith('delta')) {
    return {
      ...select(value, ['type', 'createdAt', 'sequence', 'operationId']),
      event: { type: modelEventType },
    }
  }
  if (value.type === 'tool_result' && typeof value.name === 'string') {
    return { ...value, result: publicToolResult(value.name, value.result) }
  }
  if (typeof value.toolName === 'string' && 'result' in value) {
    return { ...value, result: publicToolResult(value.toolName, value.result) }
  }
  return value
}

function publicToolResult(name: string, value: unknown) {
  return toolRegistry.projectPublicResult(name, record(value))
}

function isFact(value: Record<string, unknown>) {
  return typeof value.id === 'string' && typeof value.type === 'string'
    && typeof value.source === 'string' && typeof value.sourceReference === 'string'
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|cookie|password|client[_ -]?secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;}"']+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bbearer\s+[a-z0-9._~+\-/=]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bsk-[a-z0-9_-]{6,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bgh[pousr]_[a-z0-9_]{20,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*[a-z0-9/+=]{20,}/gi,
      '[REDACTED_CREDENTIAL]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*[^\s,;}"']+/g,
      '[REDACTED_CREDENTIAL]')
    .replace(/\bxox[baprs]-[a-z0-9-]{10,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bAIza[a-z0-9_-]{20,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,
      '[REDACTED_CREDENTIAL]')
}

function publicFactValue(fact: Record<string, unknown>) {
  const value = fact.value
  const type = String(fact.type)
  if (['quote', 'dilutedEps', 'revenue', 'netIncome', 'operatingCashFlow'].includes(type)) {
    return finiteNumber(value)
  }
  if (type === 'tool_error') return value === 'unavailable' ? value : null
  const candidate = record(value)
  if (type === 'news' || type === 'web_search_lead') return compact({
    ...(type === 'news' ? { keyword: boundedText(candidate.keyword, 500) }
      : { query: boundedText(candidate.query, 500) }),
    title: boundedText(candidate.title, 300), summary: boundedText(candidate.summary, 1_000),
    url: publicUrl(candidate.url),
  })
  if (type === 'news_document') return compact({
    candidateFactId: boundedText(candidate.candidateFactId, 500),
    url: publicUrl(candidate.url), summary: boundedText(candidate.summary, 500),
    contentHash: sha256(candidate.contentHash),
    metadata: projectNewsMetadata(candidate.metadata),
  })
  if (type === 'filing_document') return compact({
    symbol: boundedText(candidate.symbol, 20), filingId: boundedText(candidate.filingId, 100),
    form: boundedText(candidate.form, 20), filedAt: boundedText(candidate.filedAt, 50),
    startByte: nonNegativeInteger(candidate.startByte), endByte: nonNegativeInteger(candidate.endByte),
    summary: boundedText(candidate.summary, 500), contentHash: sha256(candidate.contentHash),
  })
  if (type === 'company_event') return compact({
    symbol: boundedText(candidate.symbol, 20), filingId: boundedText(candidate.filingId, 100),
    form: boundedText(candidate.form, 20), filedAt: boundedText(candidate.filedAt, 50),
    eventType: boundedText(candidate.eventType, 100), title: boundedText(candidate.title, 300),
    summary: boundedText(candidate.summary, 1_000), url: publicUrl(candidate.url),
  })
  if (type === 'daily_bar' || type === 'price_window_bar') return projectBar(candidate)
  if (type === 'indicators' || type === 'technical_indicator') return projectIndicators(candidate)
  if (type === 'technical_evidence') return projectTechnicalEvidence(candidate)
  if (type === 'reported_financial' || type === 'derived_financial_metric') {
    return compact({
      classification: boundedText(candidate.classification, 50),
      metric: boundedText(candidate.metric, 100), scope: boundedText(candidate.scope, 50),
      period: boundedText(candidate.period, 50), value: finiteNumber(candidate.value),
      ...(type === 'derived_financial_metric'
        ? { inputFactIds: stringArray(candidate.inputFactIds, 200, 500) } : {}),
    })
  }
  if (type === 'financial_quality_flag') return compact({
    classification: boundedText(candidate.classification, 50),
    flagType: boundedText(candidate.flagType, 100), severity: boundedText(candidate.severity, 50),
    period: boundedText(candidate.period, 50),
    evidenceFactIds: stringArray(candidate.evidenceFactIds, 200, 500),
  })
  if (type === 'valuation_inputs') return projectValuationInputs(candidate)
  if (type === 'deterministic_valuation') return projectDeterministicValuation(candidate)
  if (type === 'valuation') return projectValuation(candidate)
  if (type === 'valuation_multiple') return projectValuationMethod(candidate)
  return null
}

function projectNewsMetadata(value: unknown) {
  const metadata = record(value)
  return compact({
    contentType: boundedText(metadata.contentType, 100),
    excerptBytes: nonNegativeInteger(metadata.excerptBytes),
    truncated: booleanValue(metadata.truncated),
  })
}

function projectBar(value: Record<string, unknown>) {
  return compact({
    date: boundedText(value.date, 50), open: finiteNumber(value.open), high: finiteNumber(value.high),
    low: finiteNumber(value.low), close: finiteNumber(value.close), volume: finiteNumber(value.volume),
  })
}

function projectIndicators(value: Record<string, unknown>) {
  const macd = record(value.macd)
  return compact({
    symbol: boundedText(value.symbol, 20), startDate: boundedText(value.startDate, 50),
    endDate: boundedText(value.endDate, 50), barCount: nonNegativeInteger(value.barCount),
    ma_5: finiteNumber(value.ma_5), ma_20: finiteNumber(value.ma_20),
    macd: compact({
      line: finiteNumber(macd.line), signal: finiteNumber(macd.signal),
      histogram: finiteNumber(macd.histogram),
    }),
    rsi_14: finiteNumber(value.rsi_14),
    annualized_volatility: finiteNumber(value.annualized_volatility),
    max_drawdown: finiteNumber(value.max_drawdown),
    volume_ratio_5_to_20: finiteNumber(value.volume_ratio_5_to_20),
  })
}

function projectTechnicalEvidence(value: Record<string, unknown>) {
  const structures = record(value.structures)
  return compact({
    symbol: boundedText(value.symbol, 20), actualStart: boundedText(value.actualStart, 50),
    actualEnd: boundedText(value.actualEnd, 50), totalBarCount: nonNegativeInteger(value.totalBarCount),
    structures: Object.fromEntries(['20d', '60d', '120d', '252d'].flatMap((window) => {
      const item = record(structures[window])
      const projected = compact({
        status: enumText(item.status, ['available', 'unavailable']),
        reason: boundedText(item.reason, 200), barCount: nonNegativeInteger(item.barCount),
        returnPct: finiteNumber(item.returnPct), high: finiteNumber(item.high), low: finiteNumber(item.low),
      })
      return Object.keys(projected).length ? [[window, projected]] : []
    })),
    indicators: projectIndicators(record(value.indicators)),
    volatility: compact({ annualized: finiteNumber(record(value.volatility).annualized) }),
    drawdown: compact({ maximum: finiteNumber(record(value.drawdown).maximum) }),
    volumePrice: compact({
      volumeRatio5To20: finiteNumber(record(value.volumePrice).volumeRatio5To20),
    }),
    keyLevels: compact({
      support: finiteNumber(record(value.keyLevels).support),
      resistance: finiteNumber(record(value.keyLevels).resistance),
    }),
    conflicts: stringArray(value.conflicts, 20, 100),
  })
}

function projectValuationInputs(value: Record<string, unknown>) {
  return compact({
    symbol: boundedText(value.symbol, 20), industry: boundedText(value.industry, 100),
    authorizedComparables: stringArray(value.authorizedComparables, 20, 20),
    comparables: projectComparables(value.comparables), inputs: projectValuationInputNumbers(value.inputs),
    inputObservedAt: projectObservationMap(value.inputObservedAt),
    currentMultiples: projectMultiples(value.currentMultiples),
    historicalRanges: projectHistoricalRanges(value.historicalRanges),
    methods: projectValuationMethods(value.methods), asOf: boundedText(value.asOf, 50),
  })
}

function projectValuation(value: Record<string, unknown>) {
  return compact({
    symbol: boundedText(value.symbol, 20), industry: boundedText(value.industry, 100),
    comparable_symbols: stringArray(value.comparable_symbols, 20, 20),
    comparables: projectComparables(value.comparables), methods: projectValuationMethods(value.methods),
    historical_ranges: projectHistoricalRanges(value.historical_ranges),
    current_multiples: projectMultiples(value.current_multiples),
    inputs: projectValuationInputNumbers(value.inputs),
    input_observed_at: projectObservationMap(value.input_observed_at),
    source: boundedText(value.source, 100), as_of: boundedText(value.as_of, 50),
    ...projectValuationMethod(value),
  })
}

function projectDeterministicValuation(value: Record<string, unknown>) {
  return compact({
    method: boundedText(value.method, 50), status: enumText(value.status, ['available', 'unavailable']),
    inputs: stringArray(value.inputs, 200, 500), formula: boundedText(value.formula, 500),
    unit: boundedText(value.unit, 50), unitConversion: boundedText(value.unitConversion, 100),
    multiple: finiteNumber(value.multiple), targetPrice: finiteNumber(value.targetPrice),
    range: projectRange(value.range), asOf: boundedText(value.asOf, 50),
  })
}

function projectValuationMethod(value: Record<string, unknown>) {
  return compact({
    method: boundedText(value.method, 50), status: boundedText(value.status, 50),
    reason: boundedText(value.reason, 500), multiple: finiteNumber(value.multiple),
    targetPrice: finiteNumber(value.targetPrice ?? value.target_price),
    range: projectRange(value.range),
    multiplePercentile: finiteNumber(value.multiplePercentile ?? value.multiple_percentile),
    asOf: boundedText(value.asOf, 50),
  })
}

function projectValuationMethods(value: unknown) {
  const methods = record(value)
  return Object.fromEntries([
    'dcf', 'nav', 'pFfo', 'rNpv', 'pe', 'evToEbitda', 'evToRevenue', 'industry',
  ].flatMap((name) => {
    const projected = projectValuationMethod(record(methods[name]))
    return Object.keys(projected).length ? [[name, projected]] : []
  }))
}

function projectComparables(value: unknown) {
  return array(value).slice(0, 20).map((entry) => {
    const comparable = record(entry)
    return compact({
      symbol: boundedText(comparable.symbol, 20), pe: finiteNumber(comparable.pe),
      evToEbitda: finiteNumber(comparable.evToEbitda),
      evToRevenue: finiteNumber(comparable.evToRevenue),
    })
  })
}

function projectValuationInputNumbers(value: unknown) {
  const input = record(value)
  return numericRecord(input, ['currentPrice', 'dilutedEps', 'enterpriseValue', 'ebitda', 'revenue'])
}

function projectMultiples(value: unknown) {
  return numericRecord(record(value), ['pe', 'evToEbitda', 'evToRevenue'])
}

function projectHistoricalRanges(value: unknown) {
  const ranges = record(value)
  return Object.fromEntries(['pe', 'evToEbitda', 'evToRevenue'].flatMap((name) => {
    const projected = numberArray(ranges[name], 20)
    return projected.length ? [[name, projected]] : []
  }))
}

function projectObservationMap(value: unknown) {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, candidate]) => (
    /^[A-Za-z0-9_.-]{1,100}$/.test(key) && typeof candidate === 'string'
      ? [[key, candidate.slice(0, 50)]] : []
  )))
}

function projectRange(value: unknown) {
  if (Array.isArray(value)) return numberArray(value, 2)
  return numericRecord(record(value), ['low', 'high'])
}

function numericRecord(value: Record<string, unknown>, keys: string[]) {
  return compact(Object.fromEntries(keys.map((key) => [key, finiteNumber(value[key])])))
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => {
    if (candidate === undefined) return false
    if (Array.isArray(candidate)) return candidate.length > 0
    if (candidate && typeof candidate === 'object') return Object.keys(candidate).length > 0
    return true
  }))
}

function boundedText(value: unknown, limit: number) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined
}

function enumText(value: unknown, allowed: string[]) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function booleanValue(value: unknown) { return typeof value === 'boolean' ? value : undefined }

function stringArray(value: unknown, maxItems: number, maxLength: number) {
  return array(value).filter((entry): entry is string => typeof entry === 'string')
    .slice(0, maxItems).map((entry) => entry.slice(0, maxLength))
}

function numberArray(value: unknown, maxItems: number) {
  return array(value).filter((entry): entry is number => (
    typeof entry === 'number' && Number.isFinite(entry)
  )).slice(0, maxItems)
}

function sha256(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}

function publicUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.toString() : undefined
  } catch { return undefined }
}

function publicSourceReference(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined
  const publicReference = publicUrl(value)
  if (publicReference) return publicReference
  try {
    const parsed = new URL(value)
    return ['internal:', 'source:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.toString() : undefined
  } catch { return undefined }
}

function optionalValue(key: string, value: unknown) {
  return value === undefined ? {} : { [key]: value }
}

function textLimit(field: string) {
  const key = normalizeKey(field)
  if (key === 'error') return 500
  if (key === 'title') return 300
  if (['url', 'sourcereference'].includes(key)) return 2_048
  if (['keyword', 'query'].includes(key)) return 500
  if (['summary', 'reason', 'impact'].includes(key)) return 1_000
  return 20_000
}

function select(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => key in value ? [[key, value[key]]] : []))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function normalizeKey(value: string) { return value.replaceAll('-', '').replaceAll('_', '').toLowerCase() }
