import assert from 'node:assert/strict'
import test from 'node:test'

import { validateReportCandidate } from '../src/report-validation.js'

test('报告稳定外壳缺失时返回机器可读 Schema 错误而不补空占位', () => {
  const result = validateReportCandidate({ title: '旧式报告', keyJudgments: [] }, {
    role: 'main', knownFacts: [],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [
    { path: '/kind', rule: 'required', message: '缺少报告类型', allowedEvidenceTypes: [] },
    { path: '/availability', rule: 'required', message: '缺少报告可用性', allowedEvidenceTypes: [] },
    { path: '/status', rule: 'required', message: '缺少报告状态', allowedEvidenceTypes: [] },
    { path: '/gaps', rule: 'required', message: '缺少数据缺口列表', allowedEvidenceTypes: [] },
    { path: '/limitations', rule: 'required', message: '缺少报告限制列表', allowedEvidenceTypes: [] },
  ])
})

test('部分报告以 availability status 和 gaps 表达缺失且普通可选字段可省略', () => {
  const candidate = {
    kind: 'integrated', availability: 'partial', status: 'partial',
    gaps: [{ capability: 'news', reason: 'source_unavailable', impact: '无法判断消息驱动' }],
    limitations: ['近期新闻不可用'], keyJudgments: [], specialistStatuses: [],
  }
  const result = validateReportCandidate(candidate, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.report, candidate)
  assert.equal('targetPrice' in result.report, false)
})

test('引用不属于当前研究的事实时在引用完整性层返回字段路径', () => {
  const result = validateReportCandidate({
    kind: 'specialist', availability: 'available', status: 'completed', gaps: [], limitations: [],
    domain: 'news', keyJudgments: [{
      type: 'news', statement: '消息面改善', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:not-in-research'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['官方公告否认'],
    }],
  }, { role: 'news', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/keyJudgments/0/supportingEvidence/0', rule: 'reference_integrity',
    message: '事实不属于当前研究：fact:not-in-research', allowedEvidenceTypes: [],
  }])
})

test('标题级新闻只能作为线索不能支撑消息面关键判断', () => {
  const result = validateReportCandidate({
    kind: 'specialist', availability: 'available', status: 'completed', gaps: [], limitations: [],
    domain: 'news', keyJudgments: [{
      type: 'news', statement: '公司将上调指引', direction: 'bullish', confidence: 'high',
      supportingEvidence: ['fact:title-only'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['正式公告未确认'],
    }],
  }, {
    role: 'news',
    knownFacts: [{ id: 'fact:title-only', type: 'news', evidenceLevel: 'title_only' }],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/keyJudgments/0/supportingEvidence/0', rule: 'evidence_qualification',
    message: 'title_only 事实不能支撑 news 判断',
    allowedEvidenceTypes: ['verified_news', 'official_company_event'],
  }])
})

test('Web Search lead 必须读取正文核实后才能支撑消息面判断', () => {
  const result = validateReportCandidate({
    kind: 'specialist', domain: 'news', availability: 'available', status: 'completed',
    gaps: [], limitations: [], keyJudgments: [{
      type: 'news', statement: '搜索线索显示事件偏正面', direction: 'bullish', confidence: 'low',
      supportingEvidence: ['fact:web-lead'], contraryEvidence: [],
      contraryEvidenceStatus: 'not_searched', invalidationConditions: ['正文与摘要不符'],
    }],
  }, { role: 'news', knownFacts: [{
    id: 'fact:web-lead', type: 'web_search_lead', evidenceLevel: 'lead',
  }] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0]?.rule, 'evidence_qualification')
  assert.deepEqual(result.errors[0]?.allowedEvidenceTypes, ['verified_news', 'official_company_event'])
})

test('专项报告拒绝个人行动建议和跨领域裁决', () => {
  const result = validateReportCandidate({
    kind: 'specialist', availability: 'partial', status: 'partial', gaps: [], limitations: [],
    domain: 'technical', keyJudgments: [], personalImpact: '当前仓位风险较高',
    conditionalSuggestion: '若跌破支撑则减仓', integratedDirection: 'bearish',
  }, { role: 'technical', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [
    { path: '/personalImpact', rule: 'role_policy', message: '专项报告不能读取或裁决个人持仓影响', allowedEvidenceTypes: [] },
    { path: '/conditionalSuggestion', rule: 'role_policy', message: '专项报告不能给出个人行动建议', allowedEvidenceTypes: [] },
    { path: '/integratedDirection', rule: 'role_policy', message: '专项报告不能作跨领域综合裁决', allowedEvidenceTypes: [] },
  ])
})

test('结构化方向与自然语言高风险冲突时拒绝报告', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [{
      type: 'market', statement: '未来一至四周明显看跌并存在下行风险',
      direction: 'bullish', confidence: 'high', supportingEvidence: ['fact:qualified'],
      contraryEvidence: [], contraryEvidenceStatus: 'none_found', invalidationConditions: ['重新站稳高点'],
    }], specialistStatuses: [],
  }, { role: 'main', knownFacts: [{ id: 'fact:qualified', type: 'market', evidenceLevel: 'verified_market' }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/keyJudgments/0/direction', rule: 'semantic_direction_conflict',
    message: '结构化方向 bullish 与判断文本的看跌语义冲突', allowedEvidenceTypes: [],
  }])
})

test('专项 Runtime 拒绝候选伪装为综合报告', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [],
  }, { role: 'news', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/kind', rule: 'role_policy',
    message: '专项 Agent 只能提交 specialist 报告', allowedEvidenceTypes: [],
  }])
})

test('消息面 Runtime 拒绝其他领域和判断类型的专项报告', () => {
  const result = validateReportCandidate({
    kind: 'specialist', domain: 'technical', availability: 'available', status: 'completed',
    gaps: [], limitations: [], keyJudgments: [{
      type: 'technical', statement: '趋势偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:technical'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破均线'],
    }],
  }, { role: 'news', knownFacts: [{
    id: 'fact:technical', type: 'technical_indicator', evidenceLevel: 'deterministic_technical',
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule })), [
    { path: '/domain', rule: 'role_policy' },
    { path: '/keyJudgments/0/type', rule: 'role_policy' },
  ])
})

test('技术面 Runtime 只接受 technical 领域和判断类型', () => {
  const result = validateReportCandidate({
    kind: 'specialist', domain: 'fundamental_valuation', availability: 'available',
    status: 'completed', gaps: [], limitations: [], keyJudgments: [{
      type: 'fundamental', statement: '收入增长', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:technical'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['结构变化'],
    }],
  }, { role: 'technical', knownFacts: [{
    id: 'fact:technical', type: 'technical_evidence', evidenceLevel: 'deterministic_technical',
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule })), [
    { path: '/domain', rule: 'role_policy' },
    { path: '/keyJudgments/0/type', rule: 'role_policy' },
  ])
})

test('每项关键判断必须至少有一个合格支持证据', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [{
      type: 'market', statement: '短期偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: [], contraryEvidence: [], contraryEvidenceStatus: 'not_searched',
      invalidationConditions: ['跌破支撑'],
    }],
  }, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/keyJudgments/0/supportingEvidence', rule: 'evidence_qualification',
    message: '每项关键判断至少需要一个合格支持证据',
    allowedEvidenceTypes: ['market_observation', 'verified_market'],
  }])
})

test('判断级反方证据也必须属于当前研究且符合证据资格', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [{
      type: 'market', statement: '短期偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:market'], contraryEvidence: ['fact:not-in-research'],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破支撑'],
    }],
  }, { role: 'main', knownFacts: [{
    id: 'fact:market', type: 'quote', evidenceLevel: 'market_observation',
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/keyJudgments/0/contraryEvidence/0', rule: 'reference_integrity',
    message: '事实不属于当前研究：fact:not-in-research', allowedEvidenceTypes: [],
  }])
})

test('目标价拒绝空方法空输入空区间空时点和研究外引用', () => {
  const candidate = {
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [], targetPrice: {
      method: '', inputs: [], range: {}, asOf: '', evidence: ['fact:not-in-research'],
    },
  }
  const result = validateReportCandidate(candidate, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/targetPrice', rule: 'conditional_field_qualification',
    message: '目标价需要确定性估值方法、输入、区间和时点',
    allowedEvidenceTypes: ['deterministic_valuation'],
  }])
})

test('稳定 Schema 拒绝畸形数组元素和主 Agent 伪装专项报告', () => {
  const result = validateReportCandidate({
    kind: 'specialist', availability: 'available', status: 'completed',
    gaps: [{ capability: 'news', reason: 0, impact: 'unknown' }],
    limitations: [0], keyJudgments: 'invalid', supportingEvidence: [0],
  }, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule }))
    .sort((left, right) => left.path.localeCompare(right.path)), [
    { path: '/gaps/0/reason', rule: 'type' },
    { path: '/keyJudgments', rule: 'type' },
    { path: '/kind', rule: 'role_policy' },
    { path: '/limitations/0', rule: 'type' },
    { path: '/supportingEvidence/0', rule: 'type' },
  ])
})

test('稳定 Schema 逐字段校验关键判断内部结构', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [{
      type: 'unknown', statement: 0, direction: 'up', confidence: 'sure',
      supportingEvidence: [0], contraryEvidence: 'invalid', contraryEvidenceStatus: 'unknown',
      invalidationConditions: [0],
    }],
  }, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule }))
    .sort((left, right) => left.path.localeCompare(right.path)), [
    { path: '/keyJudgments/0/confidence', rule: 'enum' },
    { path: '/keyJudgments/0/contraryEvidence', rule: 'type' },
    { path: '/keyJudgments/0/contraryEvidenceStatus', rule: 'enum' },
    { path: '/keyJudgments/0/direction', rule: 'enum' },
    { path: '/keyJudgments/0/invalidationConditions/0', rule: 'type' },
    { path: '/keyJudgments/0/statement', rule: 'type' },
    { path: '/keyJudgments/0/supportingEvidence/0', rule: 'type' },
    { path: '/keyJudgments/0/type', rule: 'enum' },
  ])
})

test('稳定 Schema 拒绝非对象情景元素', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [], scenarios: [0, null, [], 'bad'],
  }, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule })), [
    { path: '/scenarios/0', rule: 'type' },
    { path: '/scenarios/1', rule: 'type' },
    { path: '/scenarios/2', rule: 'type' },
    { path: '/scenarios/3', rule: 'type' },
  ])
})

test('目标价缺少确定性估值方法输入区间或时点时拒绝条件字段', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [], specialistStatuses: [], targetPrice: { value: 250, evidence: ['fact:pe'] },
  }, { role: 'main', knownFacts: [{ id: 'fact:pe', type: 'valuation_multiple', evidenceLevel: 'verified_valuation' }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors, [{
    path: '/targetPrice', rule: 'conditional_field_qualification',
    message: '目标价需要确定性估值方法、输入、区间和时点',
    allowedEvidenceTypes: ['deterministic_valuation'],
  }])
})

test('稳定外壳拒绝空字符串零值和非法枚举占位', () => {
  const result = validateReportCandidate({
    kind: '', availability: 'unknown', status: '', gaps: 0, limitations: '',
  }, { role: 'main', knownFacts: [] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors.map(({ path, rule }) => ({ path, rule })), [
    { path: '/kind', rule: 'enum' },
    { path: '/availability', rule: 'enum' },
    { path: '/status', rule: 'enum' },
    { path: '/gaps', rule: 'type' },
    { path: '/limitations', rule: 'type' },
  ])
})

test('财务判断不能由新闻报道替代正式财务证据', () => {
  const result = validateReportCandidate({
    kind: 'specialist', availability: 'available', status: 'completed', gaps: [], limitations: [],
    domain: 'fundamental_valuation', keyJudgments: [{
      type: 'fundamental', statement: '收入增长加速', direction: 'bullish', confidence: 'high',
      supportingEvidence: ['fact:news'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['正式财报不支持'],
    }],
  }, { role: 'fundamental_valuation', knownFacts: [{
    id: 'fact:news', type: 'news', evidenceLevel: 'verified_news',
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.errors[0], {
    path: '/keyJudgments/0/supportingEvidence/0', rule: 'evidence_qualification',
    message: 'verified_news 事实不能支撑 fundamental 判断',
    allowedEvidenceTypes: [
      'official_filing', 'reported_financial',
      'deterministic_financial_metric', 'deterministic_valuation',
    ],
  })
})

test('缺少完整可用方法的估值事实不能支撑估值方向判断', () => {
  const candidate = {
    kind: 'specialist', domain: 'fundamental_valuation', availability: 'available',
    status: 'completed', gaps: [], limitations: [], keyJudgments: [{
      type: 'fundamental', statement: '当前估值偏贵', direction: 'bearish', confidence: 'medium',
      supportingEvidence: ['fact:valuation'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['估值区间改变'],
    }],
  }
  const result = validateReportCandidate(candidate, {
    role: 'fundamental_valuation', knownFacts: [{
      id: 'fact:valuation', type: 'deterministic_valuation',
      evidenceLevel: 'deterministic_valuation',
      value: { method: 'pe', status: 'unavailable', reason: 'missing_inputs_or_comparables' },
    }, { id: 'fact:inputs', type: 'valuation_inputs' }],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0]?.rule, 'evidence_qualification')
})

test('技术判断接受宿主确定性技术证据且宿主目标价事实可原样出现', () => {
  const result = validateReportCandidate({
    kind: 'integrated', availability: 'available', status: 'completed', gaps: [], limitations: [],
    keyJudgments: [{
      type: 'technical', statement: '多周期结构偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:technical'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破关键价位'],
    }], specialistStatuses: [], targetPrice: {
      method: 'DCF', inputs: ['fact:valuation'], range: { low: 210, high: 250 },
      asOf: '2026-08-13', evidence: ['fact:valuation'],
    },
  }, { role: 'main', knownFacts: [
    { id: 'fact:technical', type: 'technical_evidence', evidenceLevel: 'deterministic_technical',
      value: {
        actualStart: '2025-01-01', actualEnd: '2026-01-20', totalBarCount: 260,
        structures: Object.fromEntries([20, 60, 120, 252].map((size) => [
          `${size}d`, { status: 'available', barCount: size, returnPct: 0.1, high: 130, low: 90 },
        ])),
        indicators: { ma_5: 120, ma_20: 115, macd: { line: 1, signal: 0.5, histogram: 0.5 },
          rsi_14: 58, annualized_volatility: 0.3, max_drawdown: -0.2,
          volume_ratio_5_to_20: 1.1 },
        volatility: { annualized: 0.3 }, drawdown: { maximum: -0.2 },
        volumePrice: { volumeRatio5To20: 1.1 }, keyLevels: { support: 90, resistance: 130 },
        conflicts: [],
      } },
    { id: 'fact:valuation', type: 'deterministic_valuation', evidenceLevel: 'deterministic_valuation',
      value: { method: 'DCF', status: 'available', inputs: ['fact:valuation'],
        formula: 'discounted_cash_flow', unit: 'USD/share', unitConversion: 'none',
        range: { low: 210, high: 250 }, asOf: '2026-08-13' } },
  ] })

  assert.equal(result.ok, true)
})

test('技术判断拒绝只有标签但没有真实范围和多周期结构的事实', () => {
  const result = validateReportCandidate({
    kind: 'specialist', domain: 'technical', availability: 'available', status: 'completed',
    gaps: [], limitations: [], keyJudgments: [{
      type: 'technical', statement: '技术结构偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:technical'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破支撑'],
    }],
  }, { role: 'technical', knownFacts: [{
    id: 'fact:technical', type: 'technical_evidence', evidenceLevel: 'deterministic_technical',
    value: { totalBarCount: 20 },
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0]?.rule, 'evidence_qualification')
})

test('技术判断拒绝空壳窗口、非有限指标和倒置关键价位', () => {
  const candidate = {
    kind: 'specialist', domain: 'technical', availability: 'available', status: 'completed',
    gaps: [], limitations: [], keyJudgments: [{
      type: 'technical', statement: '技术结构偏强', direction: 'bullish', confidence: 'medium',
      supportingEvidence: ['fact:technical'], contraryEvidence: [],
      contraryEvidenceStatus: 'none_found', invalidationConditions: ['跌破支撑'],
    }],
  }
  const base = {
    actualStart: '2025-01-01', actualEnd: '2026-01-20', totalBarCount: 260,
    structures: { '20d': {}, '60d': {}, '120d': {}, '252d': {} },
    indicators: { ma_5: Number.NaN }, volatility: { annualized: Number.POSITIVE_INFINITY },
    drawdown: { maximum: -0.2 }, volumePrice: { volumeRatio5To20: 1.1 },
    keyLevels: { support: 130, resistance: 90 }, conflicts: [],
  }
  const result = validateReportCandidate(candidate, { role: 'technical', knownFacts: [{
    id: 'fact:technical', type: 'technical_evidence', evidenceLevel: 'deterministic_technical',
    value: base,
  }] })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0]?.rule, 'evidence_qualification')
})

test('只有倍数区间或与宿主事实不一致时不能生成目标价', () => {
  const candidate = {
    kind: 'specialist', domain: 'fundamental_valuation', availability: 'available',
    status: 'completed', gaps: [], limitations: [], keyJudgments: [], targetPrice: {
      method: 'PE comparable', inputs: ['fact:multiple'], range: { low: 80, high: 128 },
      asOf: '2026-08-12', evidence: ['fact:multiple'],
    },
  }
  const result = validateReportCandidate(candidate, {
    role: 'fundamental_valuation', knownFacts: [{
      id: 'fact:multiple', type: 'deterministic_valuation', evidenceLevel: 'deterministic_valuation',
      value: { method: 'evToEbitda', inputs: ['fact:multiple'], unit: 'multiple',
        range: { low: 14, high: 22 }, asOf: '2026-08-12' },
    }],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0]?.rule, 'conditional_field_qualification')
})
