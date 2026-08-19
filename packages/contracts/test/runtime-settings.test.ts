import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateModelTokenUsage,
  agentExecutionStatuses,
  defaultRuntimeSettings,
  isTerminalAgentExecutionStatus,
  isRuntimeSettingsResponse,
  parseRuntimeSettingsUpdate,
  terminalAgentExecutionStatuses,
  waitReasonForStatus,
} from '../src/index.js'

test('Token 聚合对 partial 缺失字段传播 null 且不把 unknown 计入 coverage', () => {
  assert.deepEqual(aggregateModelTokenUsage([{
    usageStatus: 'complete',
    usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3, total: 16 },
  }, {
    usageStatus: 'partial',
    usage: { input: 4, cacheRead: 1, cacheWrite: null, output: 2, total: 7 },
  }, {
    usageStatus: 'unknown',
    usage: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null },
  }]), {
    attempts: 3, reportedAttempts: 2, coverage: 2 / 3,
    input: 14, cacheRead: 3, cacheWrite: null, output: 5, total: 23,
  })
})

test('Runtime 设置默认值符合产品预算与安全上限', () => {
  assert.deepEqual(defaultRuntimeSettings, {
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
  })
})

test('Runtime 设置接受明确范围内的完整更新', () => {
  assert.deepEqual(parseRuntimeSettingsUpdate({
    mainAgentToolRounds: 500,
    specialistAgentToolRounds: 500,
    researchActiveMinutes: 240,
    executionWallClockMinutes: 240,
    analysisConcurrency: 16,
    modelConcurrency: 32,
    toolConcurrency: 64,
    modelRequestTimeoutMinutes: 60,
    reportFreshnessDays: 365,
    compactionReserveTokens: 1_000_000,
  }), {
    mainAgentToolRounds: 500,
    specialistAgentToolRounds: 500,
    researchActiveMinutes: 240,
    executionWallClockMinutes: 240,
    analysisConcurrency: 16,
    modelConcurrency: 32,
    toolConcurrency: 64,
    modelRequestTimeoutMinutes: 60,
    reportFreshnessDays: 365,
    compactionReserveTokens: 1_000_000,
  })
})

test('Runtime 设置拒绝未知 key、非法类型和越界值', () => {
  assert.throws(() => parseRuntimeSettingsUpdate({ surprise: 1 }), /unknown_runtime_setting:surprise/)
  assert.throws(() => parseRuntimeSettingsUpdate({ mainAgentToolRounds: '20' }), /invalid_runtime_setting:mainAgentToolRounds/)
  assert.throws(() => parseRuntimeSettingsUpdate({ mainAgentToolRounds: 501 }), /invalid_runtime_setting:mainAgentToolRounds/)
  assert.throws(() => parseRuntimeSettingsUpdate({ modelRequestTimeoutMinutes: 61 }), /invalid_runtime_setting:modelRequestTimeoutMinutes/)
  assert.throws(() => parseRuntimeSettingsUpdate({ executionWallClockMinutes: 241 }), /invalid_runtime_setting:executionWallClockMinutes/)
  assert.throws(() => parseRuntimeSettingsUpdate({}), /runtime_settings_update_empty/)
})

test('Settings HTTP 响应守卫拒绝缺字段与越界值', () => {
  const response = {
    model: { configured: true },
    current: { id: 1, values: { ...defaultRuntimeSettings }, createdAt: '2026-08-13T00:00:00Z' },
    defaults: { ...defaultRuntimeSettings },
    activeExecutions: [],
  }
  assert.equal(isRuntimeSettingsResponse(response), true)
  assert.equal(isRuntimeSettingsResponse({ ...response, defaults: { ...defaultRuntimeSettings, surprise: 1 } }), false)
  assert.equal(isRuntimeSettingsResponse({
    ...response,
    current: { ...response.current, values: { ...defaultRuntimeSettings, mainAgentToolRounds: 501 } },
  }), false)
})

test('Agent execution 状态全集稳定且 waitReason 由 Runtime 确定生成', () => {
  assert.deepEqual(agentExecutionStatuses, [
    'planning', 'running_model', 'running_tools', 'waiting_for_specialists',
    'finalizing', 'completed', 'partial', 'failed', 'stopping', 'stopped',
    'interrupted', 'budget_exhausted',
  ])
  assert.deepEqual(waitReasonForStatus(
    'running_model', '主模型响应', '2026-08-13T03:00:00.000Z',
  ), {
    kind: 'model', target: '主模型响应', startedAt: '2026-08-13T03:00:00.000Z',
  })
  assert.equal(waitReasonForStatus('completed', 'ignored', '2026-08-13T03:00:00.000Z'), null)
})

test('Agent execution 终态由共享契约统一判定', () => {
  assert.deepEqual(terminalAgentExecutionStatuses, [
    'completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted',
  ])
  assert.equal(isTerminalAgentExecutionStatus('stopped'), true)
  assert.equal(isTerminalAgentExecutionStatus('budget_exhausted'), true)
  assert.equal(isTerminalAgentExecutionStatus('budget_exhausted', false), false)
  assert.equal(isTerminalAgentExecutionStatus('budget_exhausted', true), true)
  assert.equal(isTerminalAgentExecutionStatus('completed', false), false)
  assert.equal(isTerminalAgentExecutionStatus('stopping'), false)
  assert.equal(isTerminalAgentExecutionStatus('cancelled'), false)
})
