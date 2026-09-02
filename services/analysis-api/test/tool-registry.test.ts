import assert from 'node:assert/strict'
import test from 'node:test'

import { Type } from '@earendil-works/pi-ai'

import {
  createToolRegistry,
  registeredToolDefinitions,
  type RegisteredToolDefinition,
} from '../src/tool-registry.js'

function definition(
  name: string,
  overrides: Partial<RegisteredToolDefinition> = {},
): RegisteredToolDefinition {
  return {
    model: {
      name,
      description: `${name} description`,
      parameters: Type.Object({}),
    },
    resultSchema: Type.Object({ facts: Type.Array(Type.Unknown()) }),
    allowedRoles: ['main'],
    allowedStages: ['research'],
    sideEffect: 'read_only',
    externalNetwork: 'none',
    hostAccess: 'none',
    resultRetention: 'research_record',
    modelProjection: 'full_result',
    executionMode: 'sequential',
    countsAsToolRound: true,
    ...overrides,
  }
}

test('唯一 Registry 中每个工具独立声明完整权限、保留、网络、投影与轮次 metadata', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.list().map((tool) => tool.model.name), [
    'fetch_financial_context',
    'run_fundamental_analysis',
    'run_news_analysis',
    'run_technical_analysis',
    'submit_analysis_report',
    'create_research_report',
    'spawn_agent', 'wait_agent', 'read_agent_result', 'stop_agent',
    'get_financial_overview',
    'get_financial_metric_series',
    'get_valuation_evidence',
    'get_technical_evidence',
    'get_price_window',
    'read_filing_document',
    'search_news_candidates',
    'search_web_evidence',
    'read_news_document',
    'list_company_events',
    'submit_specialist_report',
  ])
  for (const tool of registry.list()) {
    assert.ok(tool.allowedRoles.length > 0)
    assert.ok(tool.allowedStages.length > 0)
    assert.ok(tool.sideEffect)
    assert.ok(tool.externalNetwork)
    assert.equal(tool.hostAccess, 'none')
    assert.ok(tool.resultRetention)
    assert.ok(tool.modelProjection)
    assert.ok(tool.executionMode)
    assert.equal(typeof tool.countsAsToolRound, 'boolean')
  }
})

test('Registry 启动校验 fail closed 拒绝重复名称、缺失 schema 和非法声明', () => {
  assert.throws(() => createToolRegistry([definition('duplicate'), definition('duplicate')]),
    /tool_registry_invalid:duplicate_name/)
  assert.throws(() => createToolRegistry([definition('bad-parameters', {
    model: { name: 'bad-parameters', description: 'bad', parameters: undefined as never },
  })]), /tool_registry_invalid:parameters_schema/)
  assert.throws(() => createToolRegistry([definition('bad-result', {
    resultSchema: undefined as never,
  })]), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('semantic-bad-result', {
    resultSchema: { description: 'missing type' },
  })]), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('illegal-schema-type', {
    resultSchema: { type: 'definitely-not-json-schema' },
  })]), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('bad-roles', {
    allowedRoles: [],
  })]), /tool_registry_invalid:allowed_roles/)
  assert.throws(() => createToolRegistry([definition('bad-stages', {
    allowedStages: [],
  })]), /tool_registry_invalid:allowed_stages/)
  assert.throws(() => createToolRegistry([definition('illegal-role', {
    allowedRoles: ['arbitrary'] as never,
  })]), /tool_registry_invalid:allowed_roles/)
  assert.throws(() => createToolRegistry([definition('illegal-stage', {
    allowedStages: ['secret_phase'] as never,
  })]), /tool_registry_invalid:allowed_stages/)
  assert.throws(() => createToolRegistry([definition('bad-network', {
    externalNetwork: undefined as never,
  })]), /tool_registry_invalid:external_network/)
  assert.throws(() => createToolRegistry([definition('bad-retention', {
    resultRetention: undefined as never,
  })]), /tool_registry_invalid:result_retention/)
  assert.throws(() => createToolRegistry([definition('illegal-network', {
    externalNetwork: 'arbitrary' as never,
  })]), /tool_registry_invalid:external_network/)
  assert.throws(() => createToolRegistry([definition('illegal-effect', {
    sideEffect: 'arbitrary' as never,
  })]), /tool_registry_invalid:side_effect/)
})

test('Registry 启动时拒绝 Shell、命令执行和任意文件能力', () => {
  for (const name of ['shell_exec', 'execute_command', 'read_file', 'write_file', 'filesystem_browser']) {
    assert.throws(
      () => createToolRegistry([definition(name)]),
      new RegExp(`tool_registry_invalid:prohibited_capability:${name}`),
    )
  }
  assert.throws(() => createToolRegistry([definition('inspect_workspace', {
    hostAccess: undefined,
  } as Partial<RegisteredToolDefinition>)]),
  /tool_registry_invalid:host_access:inspect_workspace/)
  assert.throws(() => createToolRegistry([definition('inspect_workspace', {
    hostAccess: 'filesystem',
  } as unknown as Partial<RegisteredToolDefinition>)]),
  /tool_registry_invalid:host_access:inspect_workspace/)
})

test('Registry 启动时校验综合与专项报告工具的角色、网络、保留和投影策略', () => {
  const reportMetadata: Partial<RegisteredToolDefinition> = {
    sideEffect: 'creates_report', externalNetwork: 'none', resultRetention: 'report_version',
    modelProjection: 'acknowledgement', executionMode: 'sequential',
  }
  assert.throws(() => createToolRegistry([definition('submit_analysis_report', {
    ...reportMetadata, allowedRoles: ['news'],
  })]), /tool_registry_invalid:report_policy:submit_analysis_report/)
  assert.throws(() => createToolRegistry([definition('submit_specialist_report', {
    ...reportMetadata, allowedRoles: ['main'],
  })]), /tool_registry_invalid:report_policy:submit_specialist_report/)
  assert.throws(() => createToolRegistry([definition('submit_analysis_report', {
    ...reportMetadata, externalNetwork: 'financial_data',
  })]), /tool_registry_invalid:report_policy:submit_analysis_report/)
  assert.throws(() => createToolRegistry([definition('hidden_report_writer', reportMetadata)]),
    /tool_registry_invalid:report_policy:hidden_report_writer/)
})

test('Registry 只按角色和阶段返回模型定义且不提供隐藏工具 discovery', () => {
  const registry = createToolRegistry([
    definition('main-research'),
    definition('fundamental-research', { allowedRoles: ['fundamental'] }),
    definition('main-finalize', { allowedStages: ['finalization'] }),
  ])
  assert.deepEqual(registry.project({ role: 'main', stage: 'research' }).map((tool) => tool.name), [
    'main-research',
  ])
  assert.deepEqual(registry.project({ role: 'main', stage: 'finalization' }).map((tool) => tool.name), [
    'main-finalize',
  ])
  assert.equal('get' in registry, false)
  assert.equal('has' in registry, false)
})

test('自由对话普通闲聊不投影研究工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '测试测试' }).map(({ name }) => name),
    [],
  )
})

test('自由对话含 symbol 的宽泛研究只投影金融上下文工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '请研究一下 NVDA 最近怎么样。' })
      .map(({ name }) => name),
    ['fetch_financial_context'],
  )
})

test('自由对话技术和 K线意图只投影技术证据与价格窗口', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '看看 NVDA 的 K线、均线和 RSI。' })
      .map(({ name }) => name),
    ['get_technical_evidence', 'get_price_window'],
  )
})

test('自由对话基本面估值和财报意图只投影财务与 Filing 工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '分析 NVDA 最新财报、基本面和估值。' })
      .map(({ name }) => name),
    [
      'get_financial_overview', 'get_financial_metric_series',
      'get_valuation_evidence', 'read_filing_document',
    ],
  )
})

test('自由对话新闻和事件意图只投影消息面工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: 'NVDA 最近有什么新闻和公司事件？' })
      .map(({ name }) => name),
    ['search_news_candidates', 'read_news_document', 'list_company_events'],
  )
})

test('自由对话只在显式请求时投影报告和受控 subagent 工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '解释一下什么是研究报告和 subagent。' })
      .map(({ name }) => name),
    [],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '请生成一份 NVDA 研究报告，并派一个子 Agent 并行核对。' })
      .map(({ name }) => name),
    [
      'fetch_financial_context', 'create_research_report', 'spawn_agent', 'wait_agent',
      'read_agent_result', 'stop_agent',
    ],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '读取刚才的子 Agent 结果。' })
      .map(({ name }) => name),
    ['spawn_agent', 'wait_agent', 'read_agent_result', 'stop_agent'],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '给我解释一下研究报告是什么。' })
      .map(({ name }) => name),
    [],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '帮我做一份 NVDA 研究报告，并让子 Agent 分析。' })
      .map(({ name }) => name),
    [
      'fetch_financial_context', 'create_research_report', 'spawn_agent', 'wait_agent',
      'read_agent_result', 'stop_agent',
    ],
  )
})

test('自由对话识别小写 ticker 和常见技术表达但不把 API 当作标的', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(
    registry.projectConversation({ userMessage: '看看 nvda 最近怎么样。' }).map(({ name }) => name),
    ['fetch_financial_context'],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '看看 NVDA 的走势和形态。' }).map(({ name }) => name),
    ['get_technical_evidence', 'get_price_window'],
  )
  assert.deepEqual(
    registry.projectConversation({ userMessage: '这个 API 怎么使用？' }).map(({ name }) => name),
    [],
  )
})

test('自由对话不把中文格式占位符当作 ticker 且保留单字母标的', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.projectConversation({
    userMessage: '继续部署流式验收：不要调用工具。请输出20行，每行格式“第N行：流式响应正在工作”',
  }).map(({ name }) => name), [])
  assert.deepEqual(
    registry.projectConversation({ userMessage: '研究F股票最近怎么样。' }).map(({ name }) => name),
    ['fetch_financial_context'],
  )
})

test('Registry 用户投影按具体工具收紧嵌套结果并拒绝未知工具或字段', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.projectPublicResult('get_financial_overview', {
    facts: [], overview: {
      symbol: 'NVDA', latestPeriod: '2026-Q2',
      qualityFlags: [{ flag_type: 'margin_pressure', severity: 'medium', period: '2026-Q2' }],
      providerEnvelope: { response: '原包' }, articleText: '版权全文',
    }, privateDiagnostic: '内部诊断',
  }), {
    facts: [], overview: {
      symbol: 'NVDA', latestPeriod: '2026-Q2',
      qualityFlags: [{ flag_type: 'margin_pressure', severity: 'medium', period: '2026-Q2' }],
    },
  })
  assert.deepEqual(registry.projectPublicResult('unknown-tool', { summary: '不得出现' }), {})
})

test('消息面 Agent 只获得新闻候选、文档、公司事件和专项报告工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.project({ role: 'news', stage: 'research' }).map(({ name }) => name), [
    'search_news_candidates', 'search_web_evidence', 'read_news_document',
    'list_company_events', 'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'news', stage: 'finalization' }).map(({ name }) => name), [
    'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'main', stage: 'research' }).map(({ name }) => name), [
    'fetch_financial_context', 'run_fundamental_analysis', 'run_news_analysis',
    'run_technical_analysis', 'submit_analysis_report',
  ])
})

test('基本面 Agent 只获得高层财务、Filing、官方事件和专项报告工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.project({ role: 'fundamental', stage: 'research' }).map(({ name }) => name), [
    'get_financial_overview', 'get_financial_metric_series', 'get_valuation_evidence', 'read_filing_document',
    'list_company_events', 'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'fundamental', stage: 'finalization' }).map(({ name }) => name), [
    'submit_specialist_report',
  ])
})

test('技术面 Agent 只获得确定性技术证据、受控价格窗口和专项报告工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions)
  assert.deepEqual(registry.project({ role: 'technical', stage: 'research' }).map(({ name }) => name), [
    'get_technical_evidence', 'get_price_window', 'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'technical', stage: 'finalization' }).map(({ name }) => name), [
    'submit_specialist_report',
  ])
})
