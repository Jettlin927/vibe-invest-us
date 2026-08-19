import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CompactionCapacityExhaustedError, CompactionGenerationError, createCompactionCoordinator,
  DEFAULT_KEEP_RECENT_TOKENS,
  type CompactionCut, type CompactionMetrics, type CompactionSink,
} from '../src/agent-runtime/compaction.js'
import type { PiAgentAdapterMessage, PiAgentAdapterTool } from '../src/agent-runtime/pi-agent-adapter.js'

const user = (text: string): PiAgentAdapterMessage => ({ role: 'user', content: text, timestamp: 0 })

const cut: CompactionCut = {
  messagesToSummarize: [user('旧问题'), user('旧回答')],
  turnPrefixMessages: [],
  retainedTail: [user('保留的尾部')],
  isSplitTurn: false,
}

const metrics: CompactionMetrics = {
  contextTokens: 10_000, contextWindow: 100_000,
  reserveTokens: 20_000, keepRecentTokens: 4, estimated: false,
}

const finalizationTool = {
  name: 'submit_report', label: 'submit_report', description: 'finalization', parameters: {},
  execute: async () => ({ content: [], details: {} }),
} as PiAgentAdapterTool

type SinkCall = { method: string; input: Record<string, unknown> }

function createFixture(overrides: {
  generate?: (attempt: number) => Promise<{ narrative: string; usage: unknown }>
  isAborted?: () => boolean
  sinkOverrides?: Partial<CompactionSink>
  estimateTokensAfter?: (candidate: PiAgentAdapterMessage[]) => number
  stillNeeded?: (tokensAfter: number) => boolean
  metrics?: CompactionMetrics
  keepRecentTokens?: number
} = {}) {
  const calls: SinkCall[] = []
  const emitted: Array<Record<string, unknown>> = []
  const switchedTo: Array<Record<string, unknown>> = []
  let generateAttempts = 0
  const sink: CompactionSink = {
    recordModelRequest: async (input) => { calls.push({ method: 'recordModelRequest', input }) },
    completeModelRequest: async (input) => { calls.push({ method: 'completeModelRequest', input }) },
    recordCompactionAttempt: async (input) => { calls.push({ method: 'recordCompactionAttempt', input }) },
    commitCompaction: async (input) => { calls.push({ method: 'commitCompaction', input }) },
    failCompaction: async (input) => { calls.push({ method: 'failCompaction', input }) },
    ...overrides.sinkOverrides,
  }
  const coordinator = createCompactionCoordinator({
    executionId: 'exec-1', role: 'main', sink,
    ...(overrides.keepRecentTokens === undefined ? {} : { keepRecentTokens: overrides.keepRecentTokens }),
    turnIndex: () => 3,
    activeProjectionId: () => 'projection-1',
    isAborted: overrides.isAborted ?? (() => false),
    generate: async () => {
      generateAttempts += 1
      return (overrides.generate ?? (async () => ({ narrative: '摘要', usage: { totalTokens: 5 } })))(generateAttempts)
    },
    buildSummary: (_cut, narrative) => ({ narrative }),
    wrapSummary: (summary) => user(JSON.stringify(summary)),
    emit: (entry) => emitted.push(entry),
    switchToFinalization: async (event) => {
      switchedTo.push(event)
      return [finalizationTool]
    },
  })
  const runInput = {
    cut,
    metrics: overrides.metrics ?? metrics,
    estimateTokensAfter: overrides.estimateTokensAfter ?? (() => 100),
    stillNeeded: overrides.stillNeeded ?? (() => false),
  }
  return {
    calls, emitted, switchedTo, coordinator, runInput,
    generateAttempts: () => generateAttempts,
    byMethod: (method: string) => calls.filter((call) => call.method === method),
  }
}

test('compaction 成功路径：请求审计、提交、事件与消息替换一次完成', async () => {
  const fixture = createFixture()
  const outcome = await fixture.coordinator.run(fixture.runInput)

  assert.equal(outcome.kind, 'compacted')
  if (outcome.kind !== 'compacted') return
  assert.equal(outcome.tokensAfter, 100)
  assert.deepEqual(outcome.messages.map((message) => message.role), ['user', 'user'])
  assert.equal(outcome.messages[0]!.content, JSON.stringify({ narrative: '摘要' }))
  assert.equal(outcome.messages[1]!.content, '保留的尾部')

  assert.deepEqual(fixture.calls.map((call) => call.method), [
    'recordModelRequest', 'completeModelRequest', 'commitCompaction',
  ])
  const request = fixture.byMethod('recordModelRequest')[0]!.input
  assert.equal(request.requestId, 'execution:exec-1:main:compaction:1:attempt:1')
  assert.equal(request.projectionId, 'projection-1')
  assert.equal(request.turnIndex, 3)
  const completion = fixture.byMethod('completeModelRequest')[0]!.input
  assert.equal(completion.status, 'completed')
  assert.deepEqual(completion.usage, { totalTokens: 5 })
  const commit = fixture.byMethod('commitCompaction')[0]!.input
  assert.equal(commit.id, 'execution:exec-1:main:compaction:1')
  assert.equal(commit.operationId, 'execution:exec-1:main:compaction:1:completed')
  assert.equal(commit.tokensAfter, 100)
  assert.deepEqual(commit.summary, { narrative: '摘要' })
  assert.deepEqual(
    (commit.attempts as Array<Record<string, unknown>>).map(({ attempt, status }) => ({ attempt, status })),
    [{ attempt: 1, status: 'completed' }],
  )
  const persistedEvent = commit.event as Record<string, unknown>
  assert.equal(persistedEvent.status, 'completed')
  assert.equal(persistedEvent.estimated, true)
  assert.equal(typeof persistedEvent.toSegmentId, 'string')
  assert.equal(fixture.emitted.length, 1)
  assert.equal(fixture.emitted[0]!.type, 'compaction')
  assert.equal(fixture.emitted[0]!.status, 'completed')
  assert.equal(fixture.emitted[0]!.segmentId, persistedEvent.toSegmentId)
  assert.equal(fixture.emitted[0]!.operationId, commit.operationId)
})

test('compaction 首次生成失败时记录失败 attempt 并以同一 compaction 身份重试', async () => {
  const fixture = createFixture({
    generate: async (attempt) => {
      if (attempt === 1) throw new CompactionGenerationError(new Error('boom'), { totalTokens: 7 })
      return { narrative: '重试摘要', usage: { totalTokens: 6 } }
    },
  })
  const outcome = await fixture.coordinator.run(fixture.runInput)

  assert.equal(outcome.kind, 'compacted')
  const attempts = fixture.byMethod('recordCompactionAttempt')
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]!.input.id, 'execution:exec-1:main:compaction:1')
  assert.equal(attempts[0]!.input.attempt, 1)
  assert.equal(attempts[0]!.input.status, 'failed')
  assert.deepEqual(attempts[0]!.input.usage, { totalTokens: 7 })
  const requests = fixture.byMethod('recordModelRequest')
  assert.equal(requests.length, 2)
  assert.equal(requests[1]!.input.requestId, 'execution:exec-1:main:compaction:1:attempt:2')
  const commit = fixture.byMethod('commitCompaction')[0]!.input
  assert.deepEqual(
    (commit.attempts as Array<Record<string, unknown>>).map(({ attempt, status }) => ({ attempt, status })),
    [{ attempt: 1, status: 'failed' }, { attempt: 2, status: 'completed' }],
  )
})

test('compaction 未降低上下文占用时两次尝试后转入收口并禁用后续压缩', async () => {
  const fixture = createFixture({
    estimateTokensAfter: () => 999_999,
  })
  const outcome = await fixture.coordinator.run(fixture.runInput)

  assert.equal(outcome.kind, 'switch_to_finalization')
  if (outcome.kind !== 'switch_to_finalization') return
  assert.deepEqual(outcome.tools, [finalizationTool])
  assert.equal(fixture.generateAttempts(), 2)
  assert.equal(fixture.coordinator.disabled, true)
  const attempts = fixture.byMethod('recordCompactionAttempt')
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.map((call) => call.input.usage), [{ totalTokens: 5 }, { totalTokens: 5 }])
  const completions = fixture.byMethod('completeModelRequest')
  assert.deepEqual(completions.map((call) => call.input.status), ['completed', 'completed'])
  const failure = fixture.byMethod('failCompaction')[0]!.input
  assert.equal(failure.operationId, 'execution:exec-1:main:compaction:1:failed')
  assert.equal((failure.event as Record<string, unknown>).attempts, 2)
  assert.equal(fixture.switchedTo.length, 1)
  assert.equal(fixture.switchedTo[0], failure.event)
  assert.deepEqual(fixture.emitted.map((entry) => entry.status), ['failed'])
})

test('compaction 两次失败且上下文已达窗口上限时抛出容量耗尽', async () => {
  const fixture = createFixture({
    metrics: { ...metrics, contextTokens: 100_000 },
    generate: async () => { throw new CompactionGenerationError(new Error('boom')) },
  })
  await assert.rejects(
    fixture.coordinator.run(fixture.runInput),
    (error) => error instanceof CompactionCapacityExhaustedError
      && error.message === 'compaction_capacity_exhausted',
  )
  assert.equal(fixture.coordinator.disabled, true)
  assert.equal(fixture.byMethod('failCompaction').length, 1)
  assert.equal(fixture.switchedTo.length, 0)
  assert.deepEqual(fixture.emitted.map((entry) => entry.status), ['failed'])
})

test('compaction 遇到不可重试错误时持久化 fatal 失败并原样抛出', async () => {
  const fixture = createFixture({
    generate: async () => { throw new Error('summary_provider_failed') },
  })
  await assert.rejects(fixture.coordinator.run(fixture.runInput), /summary_provider_failed/)

  assert.equal(fixture.generateAttempts(), 1)
  const failure = fixture.byMethod('failCompaction')[0]!.input
  assert.equal(failure.operationId, 'execution:exec-1:main:compaction:1:fatal')
  assert.equal((failure.event as Record<string, unknown>).attempts, 1)
  assert.deepEqual(fixture.emitted.map((entry) => entry.status), ['failed'])
  assert.equal(fixture.switchedTo.length, 0)
})

test('compaction 中止时吞掉 fencing 审计失败且 attempt 记为 cancelled', async () => {
  const fixture = createFixture({
    isAborted: () => true,
    generate: async () => { throw new CompactionGenerationError(new Error('boom')) },
    sinkOverrides: {
      completeModelRequest: async (input) => {
        throw Object.assign(new Error('agent_execution_fenced'), { input })
      },
      recordCompactionAttempt: async () => { throw new Error('agent_execution_fenced') },
    },
  })
  const outcome = await fixture.coordinator.run(fixture.runInput)

  assert.equal(outcome.kind, 'switch_to_finalization')
  assert.equal(fixture.generateAttempts(), 2)
})

test('compaction 请求审计失败仍记录失败 attempt、持久化 fatal 并传播原始错误', async () => {
  const fixture = createFixture({
    sinkOverrides: {
      recordModelRequest: async () => { throw new Error('compaction_request_audit_failed') },
    },
  })
  await assert.rejects(fixture.coordinator.run(fixture.runInput), /compaction_request_audit_failed/)

  assert.equal(fixture.generateAttempts(), 0)
  const attempts = fixture.byMethod('recordCompactionAttempt')
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]!.input.status, 'failed')
  assert.equal(
    fixture.byMethod('failCompaction')[0]!.input.operationId,
    'execution:exec-1:main:compaction:1:fatal',
  )
})

test('compaction keepRecentTokens 默认两万且可经构造参数覆盖', () => {
  assert.equal(createFixture().coordinator.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS)
  assert.equal(DEFAULT_KEEP_RECENT_TOKENS, 20_000)
  assert.equal(createFixture({ keepRecentTokens: 123 }).coordinator.keepRecentTokens, 123)
})
