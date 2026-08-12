import {
  Type,
  createProvider,
  createModels,
  fauxProvider,
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Model,
  type Api,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

type Fact = {
  id: string
  type: string
  value: unknown
  observedAt: string
  fetchedAt: string
  source: string
  sourceReference: string
}

export type AnalysisReport = {
  title: string
  marketState: string
  trend: string
  drivers: string[]
  supportingEvidence: string[]
  contraryEvidence: string[]
  scenarios: Array<{ name: string; condition: string; outcome: string }>
  invalidationConditions: string[]
  valuation: string | null
  personalImpact: string | null
  conditionalSuggestion: string | null
  limitations: string[]
  keyJudgments: Array<{ judgment: string; evidence: string[] }>
}

type TraceEntry =
  | { type: 'system_prompt'; content: string }
  | { type: 'user_input'; content: string }
  | { type: 'model_event'; event: unknown }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: unknown; isError: boolean }
  | { type: 'cancelled' }

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'trace'; entry: TraceEntry }
  | { type: 'completed'; report: AnalysisReport; usage?: unknown; stopReason?: string }
  | { type: 'cancelled' }

type AnalyzeInput = {
  symbol: string
  systemPrompt: string
  userPrompt: string
  knownFacts: Fact[]
  fetchFinancialContext: (symbol: string, signal: AbortSignal) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  signal?: AbortSignal
}

type ModelOptions = {
  fauxResponses?: AssistantMessage[]
  fauxTokensPerSecond?: number
  toolTimeoutMs?: number
  log?: (entry: Record<string, unknown>) => void
  provider?: string
  apiProtocol?: 'chat-completions' | 'responses'
  modelName?: string
  baseUrl?: string
  apiKey?: string
}

const tools = [
  {
    name: 'fetch_financial_context',
    description: '读取指定美股的标准化、只读金融上下文',
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
  },
  {
    name: 'submit_analysis_report',
    description: '提交最终结构化综合分析报告',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      marketState: Type.String({ minLength: 1 }),
      trend: Type.String({ minLength: 1 }),
      drivers: Type.Array(Type.String()),
      supportingEvidence: Type.Array(Type.String(), {
        minItems: 1,
        description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
      }),
      contraryEvidence: Type.Array(Type.String(), {
        minItems: 1,
        description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
      }),
      scenarios: Type.Array(Type.Object({
        name: Type.String({ minLength: 1 }),
        condition: Type.String({ minLength: 1 }),
        outcome: Type.String({ minLength: 1 }),
      }), { minItems: 1 }),
      invalidationConditions: Type.Array(Type.String(), { minItems: 1 }),
      valuation: Type.Union([Type.String(), Type.Null()]),
      personalImpact: Type.Union([Type.String(), Type.Null()]),
      conditionalSuggestion: Type.Union([Type.String(), Type.Null()]),
      limitations: Type.Array(Type.String()),
      keyJudgments: Type.Array(Type.Object({
        judgment: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.String(), {
          minItems: 1,
          description: '只填写工具结果中完整、原样的事实 ID，不要填写解释句子',
        }),
      }), { minItems: 1 }),
    }),
  },
] as const

export function createPiModel(options: ModelOptions = {}) {
  return {
    async *analyze(input: AnalyzeInput): AsyncGenerator<ModelEvent> {
      const models = createModels()
      let selectedModel: Model<Api>
      if (options.fauxResponses) {
        const faux = fauxProvider({ tokensPerSecond: options.fauxTokensPerSecond ?? 1000 })
        models.setProvider(faux.provider)
        faux.setResponses(options.fauxResponses)
        selectedModel = faux.getModel()
      } else if (options.provider && options.apiProtocol && options.modelName && options.baseUrl && options.apiKey) {
        const api = options.apiProtocol === 'responses' ? 'openai-responses' : 'openai-completions'
        const configuredModel: Model<Api> = {
          id: options.modelName,
          name: options.modelName,
          api,
          provider: options.provider,
          baseUrl: options.baseUrl,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_000,
        }
        const configuredProvider = createProvider({
          id: options.provider,
          name: options.provider,
          baseUrl: options.baseUrl,
          auth: {
            apiKey: {
              name: `${options.provider} API key`,
              resolve: async () => ({ auth: { apiKey: options.apiKey } }),
            },
          },
          models: [configuredModel],
          api: api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
        })
        models.setProvider(configuredProvider)
        selectedModel = models.getModel(options.provider, options.modelName) ?? configuredModel
      } else {
        throw new Error('model_not_configured')
      }
      const context: Context = {
        systemPrompt: input.systemPrompt,
        messages: [{ role: 'user' as const, content: input.userPrompt, timestamp: Date.now() }],
        tools: [...tools],
      }
      const knownFactIds = new Set(input.knownFacts.map((fact) => fact.id))
      yield { type: 'trace', entry: { type: 'system_prompt', content: input.systemPrompt } }
      yield { type: 'trace', entry: { type: 'user_input', content: input.userPrompt } }

      for (let turn = 0; turn < 6; turn += 1) {
        const stream = models.stream(selectedModel, context, { signal: input.signal, apiKey: options.apiKey })
        const iterator = stream[Symbol.asyncIterator]()
        try {
          while (true) {
            const item = await nextEvent(iterator, input.signal)
            if (item.done) break
            const event = item.value
            yield { type: 'trace', entry: { type: 'model_event', event: compactModelEvent(event) } }
            options.log?.({
              type: event.type,
              toolName: event.type === 'toolcall_end' ? event.toolCall.name : undefined,
            })
            if (event.type === 'text_delta') yield { type: 'text_delta', text: event.delta }
          }
        } catch (error) {
          if (input.signal?.aborted) {
            yield { type: 'trace', entry: { type: 'cancelled' } }
            yield { type: 'cancelled' }
            return
          }
          throw error
        }

        const message = await stream.result()
        context.messages.push(message)
        if (message.stopReason === 'aborted') {
          yield { type: 'cancelled' }
          return
        }
        if (message.stopReason === 'error') throw new Error(message.errorMessage || 'model_error')
        const calls = message.content.filter((block) => block.type === 'toolCall')
        if (!calls.length) throw new Error('report_tool_required')

        for (const call of calls) {
          const toolInput = validateToolCall([...tools], call)
          yield { type: 'trace', entry: { type: 'tool_call', name: call.name, input: toolInput } }
          if (call.name === 'submit_analysis_report') {
            const report = toolInput as AnalysisReport
            try {
              validateEvidence(report, knownFactIds)
              yield { type: 'completed', report, usage: message.usage, stopReason: message.stopReason }
              return
            } catch (error) {
              const result = {
                error: error instanceof Error ? error.message : String(error),
                instruction: '依据字段只能填写工具结果中完整、原样的事实 ID。请修正报告后重新调用 submit_analysis_report。',
              }
              context.messages.push({
                role: 'toolResult', toolCallId: call.id, toolName: call.name,
                content: [{ type: 'text', text: JSON.stringify(result) }], isError: true, timestamp: Date.now(),
              })
              yield { type: 'trace', entry: { type: 'tool_result', name: call.name, result, isError: true } }
              continue
            }
          }
          if (call.name !== 'fetch_financial_context') throw new Error(`tool_not_allowed:${call.name}`)

          let result: { facts: Fact[] } | { error: string; facts: Fact[] }
          let isError = false
          try {
            if ((toolInput as { symbol: string }).symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
              throw new Error('tool_symbol_not_allowed')
            }
            const timeoutSignal = AbortSignal.timeout(options.toolTimeoutMs ?? 5_000)
            const toolSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
            result = await input.fetchFinancialContext((toolInput as { symbol: string }).symbol, toolSignal)
            for (const fact of result.facts) knownFactIds.add(fact.id)
          } catch (error) {
            isError = true
            const factId = `fact:tool-error:${call.name}:${turn}`
            const timestamp = new Date().toISOString()
            const failureFact: Fact = {
              id: factId, type: 'tool_error', value: 'unavailable', observedAt: timestamp,
              fetchedAt: timestamp, source: 'system', sourceReference: 'internal://tool-error',
            }
            knownFactIds.add(factId)
            result = { error: error instanceof Error ? error.message : String(error), facts: [failureFact] }
          }
          context.messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: [{ type: 'text', text: JSON.stringify(result) }], isError, timestamp: Date.now(),
          })
          yield { type: 'trace', entry: { type: 'tool_result', name: call.name, result, isError } }
          options.log?.({ type: 'tool_result', toolName: call.name, isError })
        }
      }
      throw new Error('analysis_turn_limit')
    },
  }
}

function validateEvidence(report: AnalysisReport, knownFactIds: Set<string>) {
  const references = [
    ...report.supportingEvidence,
    ...report.contraryEvidence,
    ...report.keyJudgments.flatMap((judgment) => judgment.evidence),
  ]
  const unknown = references.filter((reference) => !knownFactIds.has(reference))
  if (unknown.length) throw new Error(`unknown_evidence:${unknown.join(',')}`)
}

function compactModelEvent(event: Record<string, unknown>) {
  if (event.type === 'thinking_delta' || event.type === 'text_delta') {
    return { type: event.type, delta: event.delta }
  }
  if (event.type === 'toolcall_delta') return { type: event.type, delta: event.delta }
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall as { name?: unknown } | undefined
    return { type: event.type, toolName: toolCall?.name }
  }
  return { type: event.type }
}

async function nextEvent<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next()
  if (signal.aborted) throw signal.reason
  let removeListener = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    removeListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    removeListener()
  }
}
