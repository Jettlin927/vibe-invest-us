import {
  Agent,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentTool,
  type CompactionSettings,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import type {
  Api,
  Message,
  Model,
  TextContent,
  ImageContent,
  Tool,
} from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'

export type PiAgentAdapterTool = Tool<TSchema> & {
  label: string
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<TextContent | ImageContent>
    details: unknown
    usage?: unknown
    terminate?: boolean
  }>
  executionMode?: 'sequential' | 'parallel'
}

export type PiAgentAdapterState = {
  systemPrompt: string
  model: Model<Api>
  messages: Message[]
  tools: PiAgentAdapterTool[]
  errorMessage?: string
}

type TurnBoundaryState = Pick<PiAgentAdapterState, 'systemPrompt' | 'model' | 'messages' | 'tools'>

export type PiAgentAdapterEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: Message[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: Message; toolResults: Message[] }
  | { type: 'message_start'; message: Message }
  | { type: 'message_update'; message: Message; assistantMessageEvent: unknown }
  | { type: 'message_end'; message: Message }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

type CreatePiAgentAdapterOptions = {
  initialState: {
    systemPrompt: string
    model: Model<Api>
    messages?: Message[]
    tools?: PiAgentAdapterTool[]
  }
  streamFn: StreamFn
  signal?: AbortSignal
  prepareNextTurn?: (state: TurnBoundaryState, signal?: AbortSignal) =>
    Promise<Partial<TurnBoundaryState> | undefined> | Partial<TurnBoundaryState> | undefined
  compaction?: {
    settings: CompactionSettings
    compact: (input: {
      messagesToSummarize: Message[]
      turnPrefixMessages: Message[]
      retainedTail: Message[]
      isSplitTurn: boolean
    }, signal?: AbortSignal) => Promise<Message[]>
  }
}

export function createPiAgentAdapter(options: CreatePiAgentAdapterOptions) {
  let activeModel = options.initialState.model
  let externallyAborted = options.signal?.aborted ?? false
  const agent = new Agent({
    initialState: {
      systemPrompt: options.initialState.systemPrompt,
      model: options.initialState.model,
      messages: options.initialState.messages ?? [],
      tools: options.initialState.tools as AgentTool[],
    },
    convertToLlm: (messages) => messages as Message[],
    streamFn: options.streamFn,
    toolExecution: 'parallel',
    prepareNextTurnWithContext: async (context, signal) => {
      const boundaryState: TurnBoundaryState = {
        systemPrompt: context.context.systemPrompt,
        model: activeModel,
        messages: context.context.messages as Message[],
        tools: context.context.tools as PiAgentAdapterTool[],
      }
      const replacement = await options.prepareNextTurn?.(copyBoundaryState(boundaryState), signal)
      const nextState = mergeBoundaryState(boundaryState, replacement)
      if (options.compaction && shouldCompact(
        estimateContextTokens(nextState.messages).tokens,
        nextState.model.contextWindow,
        options.compaction.settings,
      )) {
        const preparation = prepareCompaction(toCompactionEntries(nextState.messages), options.compaction.settings)
        if (preparation.ok && preparation.value) {
          nextState.messages = await options.compaction.compact({
            messagesToSummarize: preparation.value.messagesToSummarize as Message[],
            turnPrefixMessages: preparation.value.turnPrefixMessages as Message[],
            retainedTail: preparation.value.retainedTail as Message[],
            isSplitTurn: preparation.value.isSplitTurn,
          }, signal)
        }
      }
      activeModel = nextState.model
      agent.state.systemPrompt = nextState.systemPrompt
      agent.state.model = nextState.model
      agent.state.messages = nextState.messages
      agent.state.tools = nextState.tools as AgentTool[]
      return {
        context: {
          systemPrompt: nextState.systemPrompt,
          messages: nextState.messages,
          tools: nextState.tools as AgentTool[],
        },
        model: nextState.model,
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
    submit(message: Message | Message[]) {
      if (externallyAborted) return Promise.reject(abortError(options.signal?.reason))
      return agent.prompt(message)
    },
    followUp(message: Message) {
      agent.followUp(message)
    },
    abort,
    subscribe(listener: (event: PiAgentAdapterEvent, signal: AbortSignal) => Promise<void> | void) {
      return agent.subscribe((event, signal) => listener(event as PiAgentAdapterEvent, signal))
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
        model: agent.state.model,
        messages: [...agent.state.messages] as Message[],
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

function toCompactionEntries(messages: Message[]): Parameters<typeof prepareCompaction>[0] {
  return messages.map((message, index) => ({
    type: 'message',
    id: `memory-message-${index}`,
    seq: index + 1,
    parentId: index === 0 ? null : `memory-message-${index - 1}`,
    timestamp: message.timestamp,
    message,
  }))
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
