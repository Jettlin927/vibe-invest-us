import {
  Agent,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentTool,
} from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'

export type PiAgentAdapterUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export type PiAgentAdapterContent =
  | { type: 'text'; text: string; textSignature?: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }

export type PiAgentAdapterMessage =
  | { role: 'user'; content: string | PiAgentAdapterContent[]; timestamp: number }
  | {
    role: 'assistant'
    content: PiAgentAdapterContent[]
    api: string
    provider: string
    model: string
    usage: PiAgentAdapterUsage
    stopReason: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'
    errorMessage?: string
    timestamp: number
  }
  | {
    role: 'toolResult'
    toolCallId: string
    toolName: string
    content: PiAgentAdapterContent[]
    details?: unknown
    usage?: PiAgentAdapterUsage
    addedToolNames?: string[]
    isError: boolean
    timestamp: number
  }

export type PiAgentAdapterModel = {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Record<string, string | null>
  samplingParams?: Record<string, unknown>
  headers?: Record<string, string>
  compat?: unknown
}

export type PiAgentAdapterTool = {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{
    content: PiAgentAdapterContent[]
    details: unknown
    usage?: unknown
    terminate?: boolean
  }>
  executionMode?: 'sequential' | 'parallel'
}

export type PiAgentAdapterStreamEvent =
  | { type: 'start'; partial: PiAgentAdapterMessage }
  | { type: 'text_start' | 'thinking_start' | 'toolcall_start'; contentIndex: number; partial: PiAgentAdapterMessage }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string; partial: PiAgentAdapterMessage }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string; partial: PiAgentAdapterMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: Extract<PiAgentAdapterContent, { type: 'toolCall' }>; partial: PiAgentAdapterMessage }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' | 'deferred'; message: PiAgentAdapterMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: PiAgentAdapterMessage }

export type PiAgentAdapterStream = AsyncIterable<PiAgentAdapterStreamEvent> & {
  result(): Promise<PiAgentAdapterMessage>
}

export type PiAgentAdapterStreamFn = (
  model: PiAgentAdapterModel,
  context: {
    systemPrompt?: string
    messages: PiAgentAdapterMessage[]
    tools?: PiAgentAdapterTool[]
  },
  options?: { signal?: AbortSignal; apiKey?: string },
) => PiAgentAdapterStream | Promise<PiAgentAdapterStream>

export type PiAgentAdapterState = {
  systemPrompt: string
  model: PiAgentAdapterModel
  messages: PiAgentAdapterMessage[]
  tools: PiAgentAdapterTool[]
  errorMessage?: string
}

type TurnBoundaryState = Pick<PiAgentAdapterState, 'systemPrompt' | 'model' | 'messages' | 'tools'>

export type PiToolProjectionCommit = (
  state: TurnBoundaryState, signal?: AbortSignal,
) => Promise<{ tools: PiAgentAdapterTool[] } | undefined>

export type PiAgentAdapterEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: PiAgentAdapterMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: PiAgentAdapterMessage; toolResults: PiAgentAdapterMessage[] }
  | { type: 'message_start'; message: PiAgentAdapterMessage }
  | { type: 'message_update'; message: PiAgentAdapterMessage; assistantMessageEvent: PiAgentAdapterStreamEvent }
  | { type: 'message_end'; message: PiAgentAdapterMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

type CreatePiAgentAdapterOptions = {
  initialState: {
    systemPrompt: string
    model: PiAgentAdapterModel
    messages?: PiAgentAdapterMessage[]
    tools?: PiAgentAdapterTool[]
  }
  streamFn: PiAgentAdapterStreamFn
  beforeToolCall?: (context: PiBeforeToolCallContext, signal?: AbortSignal) =>
    Promise<PiBeforeToolCallResult | undefined>
  afterToolCall?: (context: PiAfterToolCallContext, signal?: AbortSignal) =>
    Promise<PiAfterToolCallResult | undefined>
  shouldStopAfterTurn?: (context: PiShouldStopAfterTurnContext, signal?: AbortSignal) =>
    boolean | Promise<boolean>
  signal?: AbortSignal
  prepareNextTurn?: (state: TurnBoundaryState, signal?: AbortSignal) =>
    Promise<Partial<TurnBoundaryState> | undefined> | Partial<TurnBoundaryState> | undefined
  commitToolProjection?: PiToolProjectionCommit
  compaction?: {
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
    allowed?: () => boolean
    onContextUsage?: (input: {
      contextTokens: number; contextWindow: number
      reserveTokens: number; keepRecentTokens: number; estimated: boolean
    }, signal?: AbortSignal) => Promise<void> | void
    compact: (input: {
      messagesToSummarize: PiAgentAdapterMessage[]
      turnPrefixMessages: PiAgentAdapterMessage[]
      retainedTail: PiAgentAdapterMessage[]
      isSplitTurn: boolean
    }, signal?: AbortSignal) => Promise<PiAgentAdapterMessage[]>
    shouldRetry?: (error: unknown) => boolean
    commit?: (input: {
      compactedMessages: PiAgentAdapterMessage[]
      messagesToSummarize: PiAgentAdapterMessage[]
      turnPrefixMessages: PiAgentAdapterMessage[]
      retainedTail: PiAgentAdapterMessage[]
      isSplitTurn: boolean
      contextTokens: number
      tokensAfter: number
      contextWindow: number
      reserveTokens: number
      keepRecentTokens: number
    }, signal?: AbortSignal) => Promise<void> | void
    onAttempt?: (input: {
      attempt: 1 | 2; contextTokens: number; contextWindow: number
      reserveTokens: number; keepRecentTokens: number
    }, signal?: AbortSignal) => Promise<void> | void
    onAttemptFailure?: (input: {
      attempt: 1 | 2; durationMs: number; error: unknown
    }, signal?: AbortSignal) => Promise<void> | void
    onFatalFailure?: (error: unknown, signal?: AbortSignal) => Promise<void> | void
    onFailure?: (
      error: AggregateError, signal?: AbortSignal,
    ) => Promise<{ tools?: PiAgentAdapterTool[] } | void> | { tools?: PiAgentAdapterTool[] } | void
  }
}

type PiBeforeToolCallContext = {
  assistantMessage: PiAgentAdapterMessage
  toolCall: Extract<PiAgentAdapterContent, { type: 'toolCall' }>
  args: unknown
  context: { systemPrompt: string; messages: PiAgentAdapterMessage[]; tools?: PiAgentAdapterTool[] }
}

type PiBeforeToolCallResult = { block?: boolean; reason?: string; terminate?: boolean }

type PiAfterToolCallContext = PiBeforeToolCallContext & {
  result: { content: PiAgentAdapterContent[]; details?: unknown; usage?: unknown; terminate?: boolean }
  isError: boolean
}

type PiAfterToolCallResult = {
  content?: PiAgentAdapterContent[]; details?: unknown; isError?: boolean
  usage?: unknown; terminate?: boolean
}

type PiShouldStopAfterTurnContext = {
  message: PiAgentAdapterMessage
  toolResults: PiAgentAdapterMessage[]
  context: { systemPrompt: string; messages: PiAgentAdapterMessage[]; tools?: PiAgentAdapterTool[] }
  newMessages: PiAgentAdapterMessage[]
}

export function createPiAgentAdapter(options: CreatePiAgentAdapterOptions) {
  let activeModel = options.initialState.model
  let externallyAborted = options.signal?.aborted ?? false
  const agent = new Agent({
    initialState: {
      systemPrompt: options.initialState.systemPrompt,
      model: toPiModel(options.initialState.model),
      messages: toPiMessages(options.initialState.messages ?? []),
      tools: options.initialState.tools as AgentTool[],
    },
    convertToLlm: (messages) => messages as Message[],
    streamFn: async (model, context, streamOptions) => {
      const boundaryState: TurnBoundaryState = {
        systemPrompt: context.systemPrompt ?? '',
        model: fromPiModel(model),
        messages: fromPiMessages(context.messages as Message[]),
        tools: (context.tools ?? []) as PiAgentAdapterTool[],
      }
      return options.streamFn(
        boundaryState.model,
        {
          systemPrompt: boundaryState.systemPrompt,
          messages: boundaryState.messages,
          tools: boundaryState.tools,
        },
        { signal: streamOptions?.signal, apiKey: streamOptions?.apiKey },
      ) as unknown as AssistantMessageEventStream
    },
    toolExecution: 'parallel',
    beforeToolCall: options.beforeToolCall as Agent['beforeToolCall'],
    afterToolCall: options.afterToolCall as Agent['afterToolCall'],
    shouldStopAfterTurn: options.shouldStopAfterTurn as Agent['shouldStopAfterTurn'],
    prepareNextTurnWithContext: async (context, signal) => {
      const boundaryState: TurnBoundaryState = {
        systemPrompt: context.context.systemPrompt,
        model: activeModel,
        messages: fromPiMessages(context.context.messages as Message[]),
        tools: context.context.tools as PiAgentAdapterTool[],
      }
      const replacement = await options.prepareNextTurn?.(copyBoundaryState(boundaryState), signal)
      const nextState = mergeBoundaryState(boundaryState, replacement)
      if (toolDefinitionsChanged(boundaryState.tools, nextState.tools) && !options.commitToolProjection) {
        throw new Error('tool_projection_commit_required')
      }
      const persistedProjection = await options.commitToolProjection?.(copyBoundaryState(nextState), signal)
      if (persistedProjection) nextState.tools = [...persistedProjection.tools]
      const contextTokens = estimateContextTokens(toPiMessages(nextState.messages)).tokens
      const latestAssistant = [...nextState.messages].reverse().find(
        (message) => message.role === 'assistant',
      )
      const reportedTotal = latestAssistant?.role === 'assistant'
        ? latestAssistant.usage.totalTokens : 0
      const providerTokens = Number.isFinite(reportedTotal) && reportedTotal > 0
        ? reportedTotal
        : latestAssistant?.role === 'assistant'
          ? latestAssistant.usage.input + latestAssistant.usage.cacheRead
            + latestAssistant.usage.cacheWrite + latestAssistant.usage.output
          : 0
      const measuredContextTokens = providerTokens > 0 ? providerTokens : contextTokens
      const compactionAllowed = options.compaction?.allowed?.() ?? true
      const compactionRequired = Boolean(options.compaction && compactionAllowed && shouldCompact(
        measuredContextTokens,
        nextState.model.contextWindow,
        options.compaction.settings,
      ))
      if (options.compaction && compactionAllowed) await options.compaction.onContextUsage?.({
        contextTokens: measuredContextTokens, contextWindow: nextState.model.contextWindow,
        reserveTokens: options.compaction.settings.reserveTokens,
        keepRecentTokens: options.compaction.settings.keepRecentTokens,
        estimated: providerTokens <= 0,
      }, signal)
      if (options.compaction && compactionRequired) {
        const preparation = prepareCompaction(toCompactionEntries(nextState.messages), options.compaction.settings)
        if (preparation.ok && preparation.value) {
          const compactInput = {
            messagesToSummarize: fromPiMessages(preparation.value.messagesToSummarize as Message[]),
            turnPrefixMessages: fromPiMessages(preparation.value.turnPrefixMessages as Message[]),
            retainedTail: fromPiMessages(preparation.value.retainedTail as Message[]),
            isSplitTurn: preparation.value.isSplitTurn,
          }
          let compacted: PiAgentAdapterMessage[] | undefined
          let firstError: unknown
          for (const attempt of [1, 2] as const) {
            const attemptStartedAt = Date.now()
            try {
              await options.compaction.onAttempt?.({
                attempt, contextTokens: measuredContextTokens,
                contextWindow: nextState.model.contextWindow,
                reserveTokens: options.compaction.settings.reserveTokens,
                keepRecentTokens: options.compaction.settings.keepRecentTokens,
              }, signal)
              compacted = await options.compaction.compact(compactInput, signal)
              break
            } catch (error) {
              await options.compaction.onAttemptFailure?.({
                attempt, durationMs: Date.now() - attemptStartedAt, error,
              }, signal)
              if (!(options.compaction.shouldRetry?.(error) ?? true)) {
                await options.compaction.onFatalFailure?.(error, signal)
                throw error
              }
              firstError ??= error
            }
          }
          if (!compacted) {
            const failure = new AggregateError([firstError], 'compaction_failed_after_retry')
            if (!options.compaction.onFailure) throw failure
            const fallback = await options.compaction.onFailure(failure, signal)
            if (fallback?.tools) nextState.tools = [...fallback.tools]
          } else {
            await options.compaction.commit?.({
              ...compactInput, compactedMessages: compacted,
              contextTokens: measuredContextTokens,
              tokensAfter: estimateContextTokens(toPiMessages(compacted)).tokens,
              contextWindow: nextState.model.contextWindow,
              reserveTokens: options.compaction.settings.reserveTokens,
              keepRecentTokens: options.compaction.settings.keepRecentTokens,
            }, signal)
            nextState.messages = compacted
          }
        }
      }
      activeModel = nextState.model
      agent.state.systemPrompt = nextState.systemPrompt
      agent.state.model = toPiModel(nextState.model)
      agent.state.messages = toPiMessages(nextState.messages)
      agent.state.tools = nextState.tools as AgentTool[]
      return {
        context: {
          systemPrompt: nextState.systemPrompt,
          messages: toPiMessages(nextState.messages),
          tools: nextState.tools as AgentTool[],
        },
        model: toPiModel(nextState.model),
      }
    },
  })

  const abort = () => {
    externallyAborted = true
    agent.abort()
  }
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  return {
    submit(message: PiAgentAdapterMessage | PiAgentAdapterMessage[]) {
      if (externallyAborted) return Promise.reject(abortError(options.signal?.reason))
      return agent.prompt(toPiMessages(Array.isArray(message) ? message : [message]))
    },
    followUp(message: PiAgentAdapterMessage) {
      agent.followUp(toPiMessage(message))
    },
    abort,
    subscribe(listener: (event: PiAgentAdapterEvent, signal: AbortSignal) => Promise<void> | void) {
      return agent.subscribe((event, signal) => listener(fromPiEvent(event), signal))
    },
    waitForIdle() {
      return agent.waitForIdle()
    },
    isIdle() {
      return !agent.state.isStreaming
    },
    snapshot(): PiAgentAdapterState {
      return {
        systemPrompt: agent.state.systemPrompt,
        model: fromPiModel(agent.state.model),
        messages: fromPiMessages(agent.state.messages as Message[]),
        tools: [...agent.state.tools] as PiAgentAdapterTool[],
        errorMessage: agent.state.errorMessage,
      }
    },
    dispose() {
      options.signal?.removeEventListener('abort', abort)
      agent.abort()
      agent.reset()
    },
  }
}

function toolDefinitionsChanged(current: PiAgentAdapterTool[], next: PiAgentAdapterTool[]) {
  return JSON.stringify(current.map(modelToolDefinition)) !== JSON.stringify(next.map(modelToolDefinition))
}

function modelToolDefinition(tool: PiAgentAdapterTool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function toCompactionEntries(messages: PiAgentAdapterMessage[]): Parameters<typeof prepareCompaction>[0] {
  return messages.map((message, index) => ({
    type: 'message',
    id: `memory-message-${index}`,
    seq: index + 1,
    parentId: index === 0 ? null : `memory-message-${index - 1}`,
    timestamp: message.timestamp,
    message: toPiMessage(message),
  }))
}

function toPiModel(model: PiAgentAdapterModel): Model<Api> {
  return model as unknown as Model<Api>
}

function fromPiModel(model: Model<Api>): PiAgentAdapterModel {
  return { ...model } as unknown as PiAgentAdapterModel
}

function toPiMessage(message: PiAgentAdapterMessage): Message {
  return message as unknown as Message
}

function toPiMessages(messages: PiAgentAdapterMessage[]): Message[] {
  return messages.map(toPiMessage)
}

function fromPiMessage(message: Message): PiAgentAdapterMessage {
  return {
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
  } as unknown as PiAgentAdapterMessage
}

function fromPiMessages(messages: Message[]): PiAgentAdapterMessage[] {
  return messages.map(fromPiMessage)
}

function fromPiContext(context: Context) {
  return {
    systemPrompt: context.systemPrompt,
    messages: fromPiMessages(context.messages),
    tools: context.tools as unknown as PiAgentAdapterTool[] | undefined,
  }
}

function fromPiStreamEvent(event: AssistantMessageEvent): PiAgentAdapterStreamEvent {
  return event as unknown as PiAgentAdapterStreamEvent
}

function fromPiEvent(event: Parameters<Parameters<Agent['subscribe']>[0]>[0]): PiAgentAdapterEvent {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      return { type: event.type }
    case 'agent_end':
      return { type: event.type, messages: fromPiMessages(event.messages as Message[]) }
    case 'turn_end':
      return {
        type: event.type,
        message: fromPiMessage(event.message as Message),
        toolResults: fromPiMessages(event.toolResults),
      }
    case 'message_start':
    case 'message_end':
      return { type: event.type, message: fromPiMessage(event.message as Message) }
    case 'message_update':
      return {
        type: event.type,
        message: fromPiMessage(event.message as Message),
        assistantMessageEvent: fromPiStreamEvent(event.assistantMessageEvent),
      }
    case 'tool_execution_start':
      return {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args,
      }
    case 'tool_execution_update':
      return {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        args: event.args, partialResult: event.partialResult,
      }
    case 'tool_execution_end':
      return {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        result: event.result, isError: event.isError,
      }
  }
}

function abortError(reason: unknown) {
  if (reason instanceof Error) return new DOMException(reason.message, 'AbortError')
  return new DOMException('This operation was aborted', 'AbortError')
}

function copyBoundaryState(state: TurnBoundaryState): TurnBoundaryState {
  return { ...state, messages: [...state.messages], tools: [...state.tools] }
}

function mergeBoundaryState(
  current: TurnBoundaryState,
  replacement: Partial<TurnBoundaryState> | undefined,
): TurnBoundaryState {
  if (!replacement) return copyBoundaryState(current)
  return {
    systemPrompt: replacement.systemPrompt ?? current.systemPrompt,
    model: replacement.model ?? current.model,
    messages: [...(replacement.messages ?? current.messages)],
    tools: [...(replacement.tools ?? current.tools)],
  }
}
