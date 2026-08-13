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
  signal?: AbortSignal
  prepareNextTurn?: (state: TurnBoundaryState, signal?: AbortSignal) =>
    Promise<Partial<TurnBoundaryState> | undefined> | Partial<TurnBoundaryState> | undefined
  commitToolProjection?: (state: TurnBoundaryState, signal?: AbortSignal) =>
    Promise<{ tools: PiAgentAdapterTool[] } | undefined>
  compaction?: {
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
    compact: (input: {
      messagesToSummarize: PiAgentAdapterMessage[]
      turnPrefixMessages: PiAgentAdapterMessage[]
      retainedTail: PiAgentAdapterMessage[]
      isSplitTurn: boolean
    }, signal?: AbortSignal) => Promise<PiAgentAdapterMessage[]>
  }
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
    streamFn: (model, context, streamOptions) => options.streamFn(
      fromPiModel(model),
      fromPiContext(context),
      { signal: streamOptions?.signal, apiKey: streamOptions?.apiKey },
    ) as unknown as AssistantMessageEventStream,
    toolExecution: 'parallel',
    prepareNextTurnWithContext: async (context, signal) => {
      const boundaryState: TurnBoundaryState = {
        systemPrompt: context.context.systemPrompt,
        model: activeModel,
        messages: fromPiMessages(context.context.messages as Message[]),
        tools: context.context.tools as PiAgentAdapterTool[],
      }
      const replacement = await options.prepareNextTurn?.(copyBoundaryState(boundaryState), signal)
      const nextState = mergeBoundaryState(boundaryState, replacement)
      const persistedProjection = await options.commitToolProjection?.(copyBoundaryState(nextState), signal)
      if (persistedProjection) nextState.tools = [...persistedProjection.tools]
      if (options.compaction && shouldCompact(
        estimateContextTokens(toPiMessages(nextState.messages)).tokens,
        nextState.model.contextWindow,
        options.compaction.settings,
      )) {
        const preparation = prepareCompaction(toCompactionEntries(nextState.messages), options.compaction.settings)
        if (preparation.ok && preparation.value) {
          nextState.messages = await options.compaction.compact({
            messagesToSummarize: fromPiMessages(preparation.value.messagesToSummarize as Message[]),
            turnPrefixMessages: fromPiMessages(preparation.value.turnPrefixMessages as Message[]),
            retainedTail: fromPiMessages(preparation.value.retainedTail as Message[]),
            isSplitTurn: preparation.value.isSplitTurn,
          }, signal)
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
