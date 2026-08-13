import assert from 'node:assert/strict'
import test from 'node:test'

import { Type } from '@earendil-works/pi-ai'

import {
  createToolRegistry, registeredToolHandlers,
  registeredToolDefinitions,
  type RegisteredToolDefinition,
} from '../src/tool-registry.js'

const handler = async () => ({ facts: [] })

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
    resultRetention: 'research_record',
    modelProjection: 'full_result',
    executionMode: 'sequential',
    countsAsToolRound: true,
    ...overrides,
  }
}

test('唯一 Registry 中每个工具独立声明完整权限、保留、网络、投影与轮次 metadata', () => {
  const registry = createToolRegistry(registeredToolDefinitions, registeredToolHandlers)
  assert.deepEqual(registry.list().map((tool) => tool.model.name), [
    'fetch_financial_context',
    'run_fundamental_analysis',
    'run_news_analysis',
    'submit_analysis_report',
    'get_financial_overview',
    'get_financial_metric_series',
    'get_valuation_evidence',
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
    assert.ok(tool.resultRetention)
    assert.ok(tool.modelProjection)
    assert.ok(tool.executionMode)
    assert.equal(typeof tool.countsAsToolRound, 'boolean')
    assert.equal(typeof registry.handler(tool.model.name), 'function')
  }
})

test('Registry 启动校验 fail closed 拒绝重复名称、缺失 schema、handler 和声明', () => {
  assert.throws(() => createToolRegistry([definition('duplicate'), definition('duplicate')], { duplicate: handler }),
    /tool_registry_invalid:duplicate_name/)
  assert.throws(() => createToolRegistry([definition('bad-parameters', {
    model: { name: 'bad-parameters', description: 'bad', parameters: undefined as never },
  })], { 'bad-parameters': handler }), /tool_registry_invalid:parameters_schema/)
  assert.throws(() => createToolRegistry([definition('bad-result', {
    resultSchema: undefined as never,
  })], { 'bad-result': handler }), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('semantic-bad-result', {
    resultSchema: { description: 'missing type' },
  })], { 'semantic-bad-result': handler }), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('illegal-schema-type', {
    resultSchema: { type: 'definitely-not-json-schema' },
  })], { 'illegal-schema-type': handler }), /tool_registry_invalid:result_schema/)
  assert.throws(() => createToolRegistry([definition('bad-handler')], {}), /tool_registry_invalid:handler/)
  assert.throws(() => createToolRegistry([definition('bad-roles', {
    allowedRoles: [],
  })], { 'bad-roles': handler }), /tool_registry_invalid:allowed_roles/)
  assert.throws(() => createToolRegistry([definition('bad-stages', {
    allowedStages: [],
  })], { 'bad-stages': handler }), /tool_registry_invalid:allowed_stages/)
  assert.throws(() => createToolRegistry([definition('illegal-role', {
    allowedRoles: ['arbitrary'] as never,
  })], { 'illegal-role': handler }), /tool_registry_invalid:allowed_roles/)
  assert.throws(() => createToolRegistry([definition('illegal-stage', {
    allowedStages: ['secret_phase'] as never,
  })], { 'illegal-stage': handler }), /tool_registry_invalid:allowed_stages/)
  assert.throws(() => createToolRegistry([definition('bad-network', {
    externalNetwork: undefined as never,
  })], { 'bad-network': handler }), /tool_registry_invalid:external_network/)
  assert.throws(() => createToolRegistry([definition('bad-retention', {
    resultRetention: undefined as never,
  })], { 'bad-retention': handler }), /tool_registry_invalid:result_retention/)
  assert.throws(() => createToolRegistry([definition('illegal-network', {
    externalNetwork: 'arbitrary' as never,
  })], { 'illegal-network': handler }), /tool_registry_invalid:external_network/)
  assert.throws(() => createToolRegistry([definition('illegal-effect', {
    sideEffect: 'arbitrary' as never,
  })], { 'illegal-effect': handler }), /tool_registry_invalid:side_effect/)
})

test('Registry handler 缺失运行能力时 fail closed 而不是静默返回 undefined', async () => {
  await assert.rejects(registeredToolHandlers.fetch_financial_context({}, {}), /tool_handler_context_missing/)
})

test('Registry 只按角色和阶段返回模型定义且不提供隐藏工具 discovery', () => {
  const registry = createToolRegistry([
    definition('main-research'),
    definition('fundamental-research', { allowedRoles: ['fundamental'] }),
    definition('main-finalize', { allowedStages: ['finalization'] }),
  ], { 'main-research': handler, 'fundamental-research': handler, 'main-finalize': handler })
  assert.deepEqual(registry.project({ role: 'main', stage: 'research' }).map((tool) => tool.name), [
    'main-research',
  ])
  assert.deepEqual(registry.project({ role: 'main', stage: 'finalization' }).map((tool) => tool.name), [
    'main-finalize',
  ])
  assert.equal('get' in registry, false)
  assert.equal('has' in registry, false)
})

test('消息面 Agent 只获得新闻候选、文档、公司事件和专项报告工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions, registeredToolHandlers)
  assert.deepEqual(registry.project({ role: 'news', stage: 'research' }).map(({ name }) => name), [
    'search_news_candidates', 'search_web_evidence', 'read_news_document',
    'list_company_events', 'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'news', stage: 'finalization' }).map(({ name }) => name), [
    'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'main', stage: 'research' }).map(({ name }) => name), [
    'fetch_financial_context', 'run_fundamental_analysis', 'run_news_analysis', 'submit_analysis_report',
  ])
})

test('基本面 Agent 只获得高层财务、Filing、官方事件和专项报告工具', () => {
  const registry = createToolRegistry(registeredToolDefinitions, registeredToolHandlers)
  assert.deepEqual(registry.project({ role: 'fundamental', stage: 'research' }).map(({ name }) => name), [
    'get_financial_overview', 'get_financial_metric_series', 'get_valuation_evidence', 'read_filing_document',
    'list_company_events', 'submit_specialist_report',
  ])
  assert.deepEqual(registry.project({ role: 'fundamental', stage: 'finalization' }).map(({ name }) => name), [
    'submit_specialist_report',
  ])
})
