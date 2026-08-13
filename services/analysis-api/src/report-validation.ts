export type ReportValidationError = {
  path: string
  rule: string
  message: string
  allowedEvidenceTypes: string[]
}

export type ReportFact = {
  id: string
  type: string
  value?: unknown
  [key: string]: unknown
}

export type ReportValidationContext = {
  role: 'main' | 'news' | 'fundamental_valuation' | 'technical'
  knownFacts: ReportFact[]
}

export type ValidatedReport = Record<string, unknown> & {
  kind: 'integrated' | 'specialist'
  availability: 'available' | 'partial' | 'unavailable'
  status: 'completed' | 'partial'
  gaps: unknown[]
  limitations: string[]
}

export type ReportValidationResult =
  | { ok: true; report: ValidatedReport }
  | { ok: false; errors: ReportValidationError[] }

const requiredEnvelope = [
  ['kind', '缺少报告类型'],
  ['availability', '缺少报告可用性'],
  ['status', '缺少报告状态'],
  ['gaps', '缺少数据缺口列表'],
  ['limitations', '缺少报告限制列表'],
] as const

export function validateReportCandidate(
  value: unknown, context: ReportValidationContext,
): ReportValidationResult {
  const candidate = asRecord(value)
  const errors = requiredEnvelope.flatMap(([field, message]) => field in candidate ? [] : [{
    path: `/${field}`, rule: 'required', message, allowedEvidenceTypes: [],
  }])
  if (errors.length) return { ok: false, errors }
  const envelopeErrors: ReportValidationError[] = []
  if (!['integrated', 'specialist'].includes(String(candidate.kind))) envelopeErrors.push({
    path: '/kind', rule: 'enum', message: '报告类型必须是 integrated 或 specialist', allowedEvidenceTypes: [],
  })
  if (!['available', 'partial', 'unavailable'].includes(String(candidate.availability))) envelopeErrors.push({
    path: '/availability', rule: 'enum', message: '报告可用性无效', allowedEvidenceTypes: [],
  })
  if (!['completed', 'partial'].includes(String(candidate.status))) envelopeErrors.push({
    path: '/status', rule: 'enum', message: '报告状态无效', allowedEvidenceTypes: [],
  })
  if (!Array.isArray(candidate.gaps)) envelopeErrors.push({
    path: '/gaps', rule: 'type', message: '数据缺口必须是数组', allowedEvidenceTypes: [],
  })
  if (!Array.isArray(candidate.limitations)) envelopeErrors.push({
    path: '/limitations', rule: 'type', message: '报告限制必须是数组', allowedEvidenceTypes: [],
  })
  else candidate.limitations.forEach((value, index) => {
    if (typeof value !== 'string') envelopeErrors.push(typeError(`/limitations/${index}`, '报告限制必须是字符串'))
  })
  if (context.role === 'main' && candidate.kind === 'specialist') envelopeErrors.push({
    path: '/kind', rule: 'role_policy', message: '主 Agent 只能提交 integrated 报告', allowedEvidenceTypes: [],
  })
  if (context.role === 'news' && candidate.kind === 'specialist' && candidate.domain !== 'news') envelopeErrors.push({
    path: '/domain', rule: 'role_policy', message: '消息面 Agent 只能提交 news 领域报告', allowedEvidenceTypes: [],
  })
  if (context.role === 'fundamental_valuation' && candidate.kind === 'specialist'
    && candidate.domain !== 'fundamental_valuation') envelopeErrors.push({
    path: '/domain', rule: 'role_policy',
    message: '基本面 Agent 只能提交 fundamental_valuation 领域报告', allowedEvidenceTypes: [],
  })
  if (Array.isArray(candidate.gaps)) candidate.gaps.forEach((value, index) => {
    const gap = asRecord(value)
    for (const field of ['capability', 'reason', 'impact']) {
      if (typeof gap[field] !== 'string') envelopeErrors.push(typeError(
        `/gaps/${index}/${field}`, '数据缺口字段必须是字符串',
      ))
    }
  })
  if ('keyJudgments' in candidate && !Array.isArray(candidate.keyJudgments)) {
    envelopeErrors.push(typeError('/keyJudgments', '关键判断必须是数组'))
  }
  for (const field of ['supportingEvidence', 'contraryEvidence']) {
    if (field in candidate && !Array.isArray(candidate[field])) {
      envelopeErrors.push(typeError(`/${field}`, '证据引用必须是数组'))
    } else if (Array.isArray(candidate[field])) candidate[field].forEach((value, index) => {
      if (typeof value !== 'string') envelopeErrors.push(typeError(`/${field}/${index}`, '证据引用必须是字符串'))
    })
  }
  for (const field of ['drivers', 'invalidationConditions']) {
    validateOptionalStringArray(candidate, field, envelopeErrors)
  }
  for (const field of ['title', 'marketState', 'trend']) {
    if (field in candidate && typeof candidate[field] !== 'string') {
      envelopeErrors.push(typeError(`/${field}`, '报告文本字段必须是字符串'))
    }
  }
  for (const field of ['valuation', 'personalImpact', 'conditionalSuggestion']) {
    if (field in candidate && candidate[field] !== null && typeof candidate[field] !== 'string') {
      envelopeErrors.push(typeError(`/${field}`, '报告可选文本字段必须是字符串或 null'))
    }
  }
  if ('scenarios' in candidate && !Array.isArray(candidate.scenarios)) {
    envelopeErrors.push(typeError('/scenarios', '情景必须是数组'))
  } else if (Array.isArray(candidate.scenarios)) candidate.scenarios.forEach((value, index) => {
    if (!isRecord(value)) {
      envelopeErrors.push(typeError(`/scenarios/${index}`, '情景数组元素必须是对象'))
      return
    }
    const scenario = asRecord(value)
    for (const field of ['name', 'condition', 'outcome']) {
      if (field in scenario && typeof scenario[field] !== 'string') {
        envelopeErrors.push(typeError(`/scenarios/${index}/${field}`, '情景字段必须是字符串'))
      }
    }
  })
  if (Array.isArray(candidate.keyJudgments)) candidate.keyJudgments.forEach((value, index) => {
    const judgment = asRecord(value)
    validateJudgmentSchema(judgment, index, envelopeErrors)
    if (context.role === 'news' && judgment.type !== 'news') envelopeErrors.push({
      path: `/keyJudgments/${index}/type`, rule: 'role_policy',
      message: '消息面 Agent 只能提交 news 判断', allowedEvidenceTypes: [],
    })
    if (context.role === 'fundamental_valuation' && judgment.type !== 'fundamental') envelopeErrors.push({
      path: `/keyJudgments/${index}/type`, rule: 'role_policy',
      message: '基本面 Agent 只能提交 fundamental 判断', allowedEvidenceTypes: [],
    })
  })
  if (envelopeErrors.length) return { ok: false, errors: envelopeErrors }
  const facts = new Map(context.knownFacts.map((fact) => [fact.id, fact]))
  const judgments = Array.isArray(candidate.keyJudgments) ? candidate.keyJudgments : []
  const reportReferences = ['supportingEvidence', 'contraryEvidence'].flatMap((field) => (
    Array.isArray(candidate[field]) ? candidate[field].flatMap((id, evidenceIndex) => (
      typeof id === 'string' ? [{
        id, judgment: {} as Record<string, unknown>, path: `/${field}/${evidenceIndex}`,
      }] : []
    )) : []
  ))
  const judgmentReferences = judgments.flatMap((value, judgmentIndex) => {
    const judgment = asRecord(value)
    const supporting = Array.isArray(judgment.supportingEvidence)
      ? judgment.supportingEvidence : []
    const contrary = Array.isArray(judgment.contraryEvidence)
      ? judgment.contraryEvidence : []
    return [
      ...supporting.flatMap((id, evidenceIndex) => typeof id === 'string' ? [{
        id, judgment, path: `/keyJudgments/${judgmentIndex}/supportingEvidence/${evidenceIndex}`,
      }] : []),
      ...contrary.flatMap((id, evidenceIndex) => typeof id === 'string' ? [{
        id, judgment, path: `/keyJudgments/${judgmentIndex}/contraryEvidence/${evidenceIndex}`,
      }] : []),
    ]
  })
  const references = [...reportReferences, ...judgmentReferences]
  const referenceErrors = references.flatMap(({ id, path }) => facts.has(id) ? [] : [{
    path, rule: 'reference_integrity', message: `事实不属于当前研究：${id}`,
    allowedEvidenceTypes: [],
  }])
  if (referenceErrors.length) return { ok: false, errors: referenceErrors }
  const missingSupportErrors = judgments.flatMap((value, index) => {
    const judgment = asRecord(value)
    return Array.isArray(judgment.supportingEvidence) && judgment.supportingEvidence.length > 0
      ? [] : [{
          path: `/keyJudgments/${index}/supportingEvidence`, rule: 'evidence_qualification',
          message: '每项关键判断至少需要一个合格支持证据',
          allowedEvidenceTypes: allowedEvidenceFor(String(judgment.type)),
        }]
  })
  const qualificationErrors = [...missingSupportErrors, ...judgmentReferences.flatMap(({ id, judgment, path }) => {
    const fact = facts.get(id)!
    const allowed = allowedEvidenceFor(String(judgment.type))
    if (allowed.includes(evidenceLevel(fact))
      && (evidenceLevel(fact) !== 'deterministic_valuation'
        || qualifiedValuationEvidence(fact, facts))) return []
    return [{ path, rule: 'evidence_qualification',
      message: `${evidenceLevel(fact)} 事实不能支撑 ${String(judgment.type)} 判断`,
      allowedEvidenceTypes: allowed }]
  })]
  if (qualificationErrors.length) return { ok: false, errors: qualificationErrors }
  const policyErrors: ReportValidationError[] = []
  if (context.role !== 'main') {
    if (candidate.kind !== 'specialist') policyErrors.push({
      path: '/kind', rule: 'role_policy',
      message: '专项 Agent 只能提交 specialist 报告', allowedEvidenceTypes: [],
    })
    if ('personalImpact' in candidate) policyErrors.push({
      path: '/personalImpact', rule: 'role_policy',
      message: '专项报告不能读取或裁决个人持仓影响', allowedEvidenceTypes: [],
    })
    if ('conditionalSuggestion' in candidate) policyErrors.push({
      path: '/conditionalSuggestion', rule: 'role_policy',
      message: '专项报告不能给出个人行动建议', allowedEvidenceTypes: [],
    })
    if ('integratedDirection' in candidate) policyErrors.push({
      path: '/integratedDirection', rule: 'role_policy',
      message: '专项报告不能作跨领域综合裁决', allowedEvidenceTypes: [],
    })
  }
  judgments.forEach((value, index) => {
    const judgment = asRecord(value)
    const statement = typeof judgment.statement === 'string' ? judgment.statement : ''
    if (judgment.direction === 'bullish' && /看跌|下行风险|偏空/.test(statement)) {
      policyErrors.push({
        path: `/keyJudgments/${index}/direction`, rule: 'semantic_direction_conflict',
        message: '结构化方向 bullish 与判断文本的看跌语义冲突', allowedEvidenceTypes: [],
      })
    } else if (judgment.direction === 'bearish' && /看涨|上行空间|偏多/.test(statement)) {
      policyErrors.push({
        path: `/keyJudgments/${index}/direction`, rule: 'semantic_direction_conflict',
        message: '结构化方向 bearish 与判断文本的看涨语义冲突', allowedEvidenceTypes: [],
      })
    }
  })
  if ('targetPrice' in candidate && !qualifiedTargetPrice(candidate.targetPrice, facts)) {
    policyErrors.push({
      path: '/targetPrice', rule: 'conditional_field_qualification',
      message: '目标价需要确定性估值方法、输入、区间和时点',
      allowedEvidenceTypes: ['deterministic_valuation'],
    })
  }
  if (policyErrors.length) return { ok: false, errors: policyErrors }
  return { ok: true, report: candidate as ValidatedReport }
}

function qualifiedValuationEvidence(fact: ReportFact, facts: Map<string, ReportFact>) {
  const evidence = asRecord(fact.value)
  const range = asRecord(evidence.range)
  return evidence.status === 'available'
    && typeof evidence.method === 'string' && evidence.method.trim() !== ''
    && typeof evidence.formula === 'string' && evidence.formula.trim() !== ''
    && typeof evidence.unit === 'string' && evidence.unit.trim() !== ''
    && typeof evidence.unitConversion === 'string' && evidence.unitConversion.trim() !== ''
    && typeof evidence.asOf === 'string' && evidence.asOf.trim() !== ''
    && Array.isArray(evidence.inputs) && evidence.inputs.length > 0
    && evidence.inputs.every((id) => typeof id === 'string' && facts.has(id))
    && typeof range.low === 'number' && Number.isFinite(range.low)
    && typeof range.high === 'number' && Number.isFinite(range.high) && range.low <= range.high
}

function allowedEvidenceFor(judgmentType: string) {
  if (judgmentType === 'market') return ['market_observation', 'verified_market']
  if (judgmentType === 'news') return ['verified_news', 'official_company_event']
  if (judgmentType === 'fundamental') {
    return [
      'official_filing', 'reported_financial',
      'deterministic_financial_metric', 'deterministic_valuation',
    ]
  }
  if (judgmentType === 'technical') return ['deterministic_technical']
  if (judgmentType === 'operational') return ['runtime_observation']
  return []
}

function evidenceLevel(fact: ReportFact) {
  if (typeof fact.evidenceLevel === 'string') return fact.evidenceLevel
  if (fact.type === 'quote' || fact.type === 'daily_bar') return 'market_observation'
  if (fact.type === 'tool_error') return 'runtime_observation'
  return String(fact.type)
}

function qualifiedTargetPrice(value: unknown, facts: Map<string, ReportFact>) {
  const target = asRecord(value)
  const range = asRecord(target.range)
  if (typeof target.method !== 'string' || target.method.trim() === ''
    || !Array.isArray(target.inputs) || target.inputs.length === 0
    || !target.inputs.every((id) => typeof id === 'string' && facts.has(id))
    || typeof range.low !== 'number' || !Number.isFinite(range.low)
    || typeof range.high !== 'number' || !Number.isFinite(range.high) || range.low > range.high
    || typeof target.asOf !== 'string' || target.asOf.trim() === ''
    || !Array.isArray(target.evidence) || target.evidence.length === 0) return false
  return target.evidence.every((id) => {
    if (typeof id !== 'string') return false
    const fact = facts.get(id)
    if (fact?.type !== 'deterministic_valuation') return false
    const evidence = asRecord(fact.value)
    const evidenceRange = asRecord(evidence.range)
    return qualifiedValuationEvidence(fact, facts)
      && evidence.unit === 'USD/share'
      && evidence.method === target.method
      && evidence.asOf === target.asOf
      && arraysEqual(evidence.inputs, target.inputs)
      && evidenceRange.low === range.low
      && evidenceRange.high === range.high
  })
}

function arraysEqual(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index])
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateJudgmentSchema(
  judgment: Record<string, unknown>, index: number, errors: ReportValidationError[],
) {
  const prefix = `/keyJudgments/${index}`
  const enums = {
    type: ['market', 'news', 'fundamental', 'technical', 'operational'],
    direction: ['bullish', 'bearish', 'neutral'],
    confidence: ['low', 'medium', 'high'],
    contraryEvidenceStatus: ['none_found', 'not_searched', 'not_applicable'],
  }
  for (const [field, allowed] of Object.entries(enums)) if (!allowed.includes(String(judgment[field]))) {
    errors.push({ path: `${prefix}/${field}`, rule: 'enum', message: '关键判断枚举值无效', allowedEvidenceTypes: [] })
  }
  if (typeof judgment.statement !== 'string') errors.push(typeError(`${prefix}/statement`, '判断陈述必须是字符串'))
  for (const field of ['supportingEvidence', 'contraryEvidence', 'invalidationConditions']) {
    if (!Array.isArray(judgment[field])) errors.push(typeError(`${prefix}/${field}`, '关键判断数组字段无效'))
    else judgment[field].forEach((value, itemIndex) => {
      if (typeof value !== 'string') errors.push(typeError(`${prefix}/${field}/${itemIndex}`, '关键判断数组元素必须是字符串'))
    })
  }
}

function typeError(path: string, message: string): ReportValidationError {
  return { path, rule: 'type', message, allowedEvidenceTypes: [] }
}

function validateOptionalStringArray(
  candidate: Record<string, unknown>, field: string, errors: ReportValidationError[],
) {
  if (!(field in candidate)) return
  if (!Array.isArray(candidate[field])) {
    errors.push(typeError(`/${field}`, '报告数组字段无效'))
    return
  }
  candidate[field].forEach((value, index) => {
    if (typeof value !== 'string') errors.push(typeError(`/${field}/${index}`, '报告数组元素必须是字符串'))
  })
}
