import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createPiAgentAdapter,
  type PiAgentAdapterMessage,
  type PiAgentAdapterModel,
  type PiAgentAdapterStream,
  type PiAgentAdapterStreamFn,
  type PiAgentAdapterTool,
} from '../src/agent-runtime/pi-agent-adapter.js'

type AssistantMessage = Extract<PiAgentAdapterMessage, { role: 'assistant' }>

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: 'stop' | 'toolUse' = 'stop',
): AssistantMessage {
  return {
    role: 'assistant', content, api: 'faux', provider: 'faux', model: 'faux-model',
    usage, stopReason, timestamp: Date.now(),
  }
}

function textMessage(text: string) {
  return assistantMessage([{ type: 'text', text }])
}

function toolCall(name: string, id: string) {
  return { type: 'toolCall' as const, id, name, arguments: {} }
}

function createFixture(
  responses: AssistantMessage[],
  fixtureOptions: { blockLongResponse?: boolean; onAbort?: () => void } = {},
) {
  const model: PiAgentAdapterModel = {
    id: 'faux-model', name: 'Faux Model', api: 'faux', provider: 'faux', baseUrl: 'https://example.test',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 4_096,
  }
  let responseIndex = 0
  const streamFn: PiAgentAdapterStreamFn = async (_model, _context, options) => {
    const scripted = responses[responseIndex++]
    if (!scripted) throw new Error('missing_test_response')
    const result = await abortableResponse(
      scripted, options?.signal,
      fixtureOptions.blockLongResponse ?? false, fixtureOptions.onAbort,
    )
    return streamOf(result)
  }
  return {
    model,
    streamFn,
  }
}

async function abortableResponse(
  response: PiAgentAdapterMessage & { role: 'assistant' },
  signal?: AbortSignal,
  shouldBlock = false,
  onAbort?: () => void,
) {
  if (!shouldBlock) return response
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 500)
    signal?.addEventListener('abort', () => {
      onAbort?.()
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
  if (!signal?.aborted) return response
  return { ...response, stopReason: 'aborted' as const, errorMessage: 'Request was aborted' }
}

function streamOf(message: AssistantMessage): PiAgentAdapterStream {
  const event = message.stopReason === 'aborted' || message.stopReason === 'error'
    ? { type: 'error' as const, reason: message.stopReason, error: message }
    : { type: 'done' as const, reason: message.stopReason, message }
  return {
    async *[Symbol.asyncIterator]() { yield event },
    async result() { return message },
  }
}

function userMessage(content: string): PiAgentAdapterMessage {
  return { role: 'user', content, timestamp: Date.now() }
}

function textTool(name: string, execute: PiAgentAdapterTool['execute']): PiAgentAdapterTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute,
  }
}

test('默认状态没有任何工具，也不会创建文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-pi-adapter-'))
  const originalDirectory = process.cwd()
  try {
    process.chdir(directory)
    const fixture = createFixture([textMessage('完成')])
    const adapter = createPiAgentAdapter({
      initialState: { systemPrompt: 'system', model: fixture.model },
      streamFn: fixture.streamFn,
    })
    assert.deepEqual(adapter.snapshot().tools, [])
    await adapter.submit(userMessage('开始'))
    assert.deepEqual(await readdir(directory), [])
  } finally {
    process.chdir(originalDirectory)
    await rm(directory, { recursive: true, force: true })
  }
})

test('猜测隐藏工具或文件 Shell 工具时统一不可执行', async () => {
  for (const hiddenName of ['hidden_financial_tool', 'read', 'write', 'edit', 'bash']) {
    const fixture = createFixture([
      assistantMessage([toolCall(hiddenName, `call-${hiddenName}`)], 'toolUse'),
    ])
    const adapter = createPiAgentAdapter({
      initialState: { systemPrompt: 'system', model: fixture.model },
      streamFn: fixture.streamFn,
    })
    await adapter.submit(userMessage('尝试隐藏能力'))
    const result = adapter.snapshot().messages.find((message) => message.role === 'toolResult')
    assert.equal(result?.role, 'toolResult')
    if (result?.role === 'toolResult') {
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result.content), /not found/i)
    }
  }
})

test('initial state 可以从产品读取模型重建，回收后不保留第二套 Session', async () => {
  const fixture = createFixture([textMessage('继续完成')])
  const restored = [userMessage('历史问题')]
  const adapter = createPiAgentAdapter({
    initialState: { systemPrompt: 'v2', model: fixture.model, messages: restored },
    streamFn: fixture.streamFn,
  })
  assert.deepEqual(adapter.snapshot().messages, restored)
  await adapter.submit(userMessage('恢复'))
  assert.equal(adapter.snapshot().messages.at(-1)?.role, 'assistant')
  adapter.dispose()
  assert.deepEqual(adapter.snapshot().messages, [])
})

test('follow-up 在当前响应结束后触发下一轮', async () => {
  const fixture = createFixture([
    textMessage('首轮'),
    textMessage('追问轮'),
  ])
  const adapter = createPiAgentAdapter({
    initialState: { systemPrompt: 'system', model: fixture.model },
    streamFn: fixture.streamFn,
  })
  adapter.subscribe((event) => {
    if (event.type === 'agent_start') adapter.followUp(userMessage('再补充'))
  })
  await adapter.submit(userMessage('开始'))
  assert.deepEqual(adapter.snapshot().messages.map((message) => message.role), [
    'user', 'assistant', 'user', 'assistant',
  ])
})

test('外部 Abort 传播到裸 Agent 并保持 agent_end 先于 idle', async () => {
  let providerAborted = false
  const fixture = createFixture([textMessage('等待取消')], {
    blockLongResponse: true,
    onAbort: () => { providerAborted = true },
  })
  const controller = new AbortController()
  const events: string[] = []
  const adapter = createPiAgentAdapter({
    initialState: { systemPrompt: 'system', model: fixture.model },
    streamFn: fixture.streamFn,
    signal: controller.signal,
  })
  adapter.subscribe(async (event) => {
    events.push(event.type)
    if (event.type === 'agent_end') {
      assert.equal(adapter.isIdle(), false)
      await Promise.resolve()
      events.push('agent_end_listener_settled')
    }
  })
  const running = adapter.submit(userMessage('开始'))
  setTimeout(() => controller.abort(new Error('stopped')), 5)
  await running
  await adapter.waitForIdle()
  events.push('idle')
  assert.equal(providerAborted, true)
  assert.match(adapter.snapshot().errorMessage ?? '', /abort/i)
  assert.deepEqual(events.slice(-3), ['agent_end', 'agent_end_listener_settled', 'idle'])
})

test('提交前已 Abort 不会启动 Agent', async () => {
  const fixture = createFixture([textMessage('不应执行')])
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  const events: string[] = []
  const adapter = createPiAgentAdapter({
    initialState: { systemPrompt: 'system', model: fixture.model },
    streamFn: fixture.streamFn,
    signal: controller.signal,
  })
  adapter.subscribe((event) => { events.push(event.type) })
  await assert.rejects(adapter.submit(userMessage('开始')), /abort/i)
  assert.deepEqual(events, [])
  assert.deepEqual(adapter.snapshot().messages, [])
})

test('并行工具真实并发完成，但下一轮结果按原 tool call 顺序稳定排列', async () => {
  const fixture = createFixture([
    assistantMessage([toolCall('slow', 'call-slow'), toolCall('fast', 'call-fast')], 'toolUse'),
    textMessage('完成'),
  ])
  const completed: string[] = []
  let releaseSlow!: () => void
  const slowBarrier = new Promise<void>((resolve) => { releaseSlow = resolve })
  const adapter = createPiAgentAdapter({
    initialState: {
      systemPrompt: 'system',
      model: fixture.model,
      tools: [
        textTool('slow', async () => {
          await slowBarrier
          completed.push('slow')
          return { content: [{ type: 'text', text: 'slow-result' }], details: {} }
        }),
        textTool('fast', async () => {
          completed.push('fast')
          releaseSlow()
          return { content: [{ type: 'text', text: 'fast-result' }], details: {} }
        }),
      ],
    },
    streamFn: fixture.streamFn,
  })
  await adapter.submit(userMessage('开始'))
  assert.deepEqual(completed, ['fast', 'slow'])
  const results = adapter.snapshot().messages.filter((message) => message.role === 'toolResult')
  assert.deepEqual(results.map((message) => message.toolCallId), ['call-slow', 'call-fast'])
})

test('工具投影和上下文替换只在完整 turn boundary 后影响下一轮', async () => {
  const seenTools: string[][] = []
  const fixture = createFixture([
    assistantMessage([toolCall('visible_now', 'call-now')], 'toolUse'),
    assistantMessage([toolCall('visible_next', 'call-next')], 'toolUse'),
    textMessage('完成'),
  ])
  const visibleNext = textTool('visible_next', async () => ({
    content: [{ type: 'text', text: 'next' }], details: {},
  }))
  const adapter = createPiAgentAdapter({
    initialState: {
      systemPrompt: 'system', model: fixture.model,
      tools: [textTool('visible_now', async () => ({
        content: [{ type: 'text', text: 'now' }], details: {},
      }))],
    },
    streamFn: async (model, context, options) => {
      seenTools.push((context.tools ?? []).map((tool) => tool.name))
      return fixture.streamFn(model, context, options)
    },
    prepareNextTurn: async ({ messages }) => ({
      messages,
      tools: [visibleNext],
    }),
  })
  await adapter.submit(userMessage('开始'))
  assert.deepEqual(seenTools, [['visible_now'], ['visible_next'], ['visible_next']])
  assert.deepEqual(adapter.snapshot().tools.map((tool) => tool.name), ['visible_next'])
})

test('Pi compaction 阈值只在 turn boundary 切换并保留到后续提交', async () => {
  const seenContents: string[][] = []
  const cuts: Array<{ summarized: string[]; turnPrefix: string[]; retained: string[] }> = []
  const fixture = createFixture([
    assistantMessage([toolCall('continue', 'call-continue')], 'toolUse'),
    textMessage('完成'),
    textMessage('再次完成'),
  ])
  const adapter = createPiAgentAdapter({
    initialState: {
      systemPrompt: 'system', model: fixture.model,
      messages: [userMessage('旧问题'), textMessage('旧回答')],
      tools: [textTool('continue', async () => ({
        content: [{ type: 'text', text: 'continue' }], details: {},
      }))],
    },
    streamFn: async (model, context, options) => {
      seenContents.push(context.messages.map((message) => typeof message.content === 'string'
        ? message.content : JSON.stringify(message.content)))
      return fixture.streamFn(model, context, options)
    },
    compaction: {
      settings: { enabled: true, reserveTokens: fixture.model.contextWindow, keepRecentTokens: 4 },
      compact: async ({ messagesToSummarize, turnPrefixMessages, retainedTail }) => {
        cuts.push({
          summarized: messagesToSummarize.map((message) => message.role),
          turnPrefix: turnPrefixMessages.map((message) => message.role),
          retained: retainedTail.map((message) => message.role),
        })
        return [userMessage('compacted-summary'), ...retainedTail]
      },
    },
  })
  await adapter.submit(userMessage('原始内容'))
  assert.equal(seenContents[0]?.some((content) => content.includes('原始内容')), true)
  assert.deepEqual(cuts[0], {
    summarized: ['user', 'assistant'], turnPrefix: ['user'], retained: ['assistant', 'toolResult'],
  })
  assert.equal(seenContents[1]?.[0], 'compacted-summary')
  assert.deepEqual(adapter.snapshot().messages.map((message) => message.role), [
    'user', 'assistant', 'toolResult', 'assistant',
  ])
  await adapter.submit(userMessage('后续提交'))
  assert.equal(seenContents[2]?.[0], 'compacted-summary')
})
