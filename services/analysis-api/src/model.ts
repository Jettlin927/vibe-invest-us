import {
  createProvider,
  createModels,
  fauxProvider,
  validateToolCall,
  contentText,
  type AssistantMessage,
  type Context,
  type Model,
  type Api,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { analysisModelTools, financialSpecialistTools } from './tools.js'

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
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<{ facts: Fact[]; [key: string]: unknown }>
  fetchTechnicalIndicators?: (
    symbol: string, startDate: string, endDate: string, signal: AbortSignal,
  ) => Promise<{ facts: Fact[]; [key: string]: unknown }>
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
        tools: [...analysisModelTools],
      }
      const knownFactIds = new Set(input.knownFacts.map((fact) => fact.id))
      let frozenContext: Awaited<ReturnType<AnalyzeInput['fetchFinancialContext']>> | undefined
      const loadFrozenContext = async (symbol: string) => {
        if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
          throw new Error('tool_symbol_not_allowed')
        }
        if (!frozenContext) {
          const timeoutSignal = AbortSignal.timeout(options.toolTimeoutMs ?? 5_000)
          const toolSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
          frozenContext = await input.fetchFinancialContext(symbol, toolSignal)
          for (const fact of frozenContext.facts) knownFactIds.add(fact.id)
        }
        return frozenContext
      }
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
        if (!calls.length) {
          context.messages.push({
            role: 'user',
            content: '请继续自主规划。可按需使用受限工具；准备好后提交结构化报告。',
            timestamp: Date.now(),
          })
          continue
        }

        for (const call of calls) {
          const toolInput = validateToolCall([...analysisModelTools], call)
          yield { type: 'trace', entry: { type: 'tool_call', name: call.name, input: toolInput } }
          if (call.name === 'submit_analysis_report') {
            const report = normalizeReport(toolInput)
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
          if (call.name !== 'fetch_financial_context' && call.name !== 'analyze_financials') {
            throw new Error(`tool_not_allowed:${call.name}`)
          }

          let result: { facts: Fact[]; [key: string]: unknown } | { error: string; facts: Fact[] }
          let isError = false
          try {
            const toolSymbol = (toolInput as { symbol?: string }).symbol ?? input.symbol
            const financialContext = await loadFrozenContext(toolSymbol)
            if (call.name === 'analyze_financials') {
              const specialistContext: Context = {
                systemPrompt: `你是独立财报分析专家。以给定的冻结财报上下文为基础，可按需通过 search_news_by_keyword 补查新闻，或通过 get_technical_indicators 查询指定股票与日期范围的确定性技术指标。不得使用工具结果之外的信息，不重新计算宿主已经计算的增长率、利润率、TTM、自由现金流或质量标记。每项判断必须引用输入或工具结果中存在的事实 ID；数据不足时明确说明。输出供主分析 Agent 使用的简洁备忘录，不提交最终股票报告。`,
                messages: [{
                  role: 'user',
                  content: JSON.stringify({
                    symbol: input.symbol,
                    financials: financialContext.financials ?? null,
                    facts: financialContext.facts.filter((fact) => isFinancialFact(fact)),
                  }),
                  timestamp: Date.now(),
                }],
                tools: [...financialSpecialistTools],
              }
              const specialist = await runFinancialSpecialist(
                models, selectedModel, specialistContext, input, options,
              )
              for (const fact of specialist.facts) knownFactIds.add(fact.id)
              result = { facts: specialist.facts, analysis: specialist.analysis }
            } else {
              result = financialContext
            }
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

async function runFinancialSpecialist(
  models: ReturnType<typeof createModels>,
  selectedModel: Model<Api>,
  context: Context,
  input: AnalyzeInput,
  options: ModelOptions,
) {
  const facts: Fact[] = []
  for (let turn = 0; turn < 5; turn += 1) {
    const message = await models.complete(selectedModel, context, {
      signal: input.signal,
      apiKey: options.apiKey,
    })
    context.messages.push(message)
    if (message.stopReason === 'error') throw new Error(message.errorMessage || 'financial_specialist_error')
    const calls = message.content.filter((block) => block.type === 'toolCall')
    if (!calls.length) return { analysis: contentText(message.content), facts }
    for (const call of calls) {
      const toolInput = validateToolCall([...financialSpecialistTools], call)
      let result: { facts: Fact[]; [key: string]: unknown }
      let isError = false
      try {
        if (call.name === 'search_news_by_keyword') {
          if (!input.searchNews) throw new Error('news_search_unavailable')
          const keyword = (toolInput as { keyword?: string }).keyword ?? input.symbol
          result = await input.searchNews(keyword, toolSignal(input, options))
        } else if (call.name === 'get_technical_indicators') {
          if (!input.fetchTechnicalIndicators) throw new Error('technical_indicators_unavailable')
          const values = toolInput as { symbol?: string; startDate?: string; endDate?: string }
          const endDate = values.endDate ?? new Date().toISOString().slice(0, 10)
          const startDate = values.startDate ?? oneYearBefore(endDate)
          result = await input.fetchTechnicalIndicators(
            values.symbol ?? input.symbol, startDate, endDate, toolSignal(input, options),
          )
        } else {
          throw new Error(`tool_not_allowed:${call.name}`)
        }
        facts.push(...result.facts)
      } catch (error) {
        isError = true
        result = { error: error instanceof Error ? error.message : String(error), facts: [] }
      }
      context.messages.push({
        role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: JSON.stringify(result) }], isError, timestamp: Date.now(),
      })
    }
  }
  throw new Error('financial_specialist_turn_limit')
}

function toolSignal(input: AnalyzeInput, options: ModelOptions) {
  const timeoutSignal = AbortSignal.timeout(options.toolTimeoutMs ?? 30_000)
  return input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
}

function oneYearBefore(endDate: string) {
  const date = new Date(`${endDate}T00:00:00Z`)
  date.setUTCFullYear(date.getUTCFullYear() - 1)
  return date.toISOString().slice(0, 10)
}

function normalizeReport(value: unknown): AnalysisReport {
  const report = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    title: asString(report.title), marketState: asString(report.marketState), trend: asString(report.trend),
    drivers: asStringArray(report.drivers), supportingEvidence: asStringArray(report.supportingEvidence),
    contraryEvidence: asStringArray(report.contraryEvidence),
    scenarios: Array.isArray(report.scenarios) ? report.scenarios.map((item) => {
      const scenario = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { name: asString(scenario.name), condition: asString(scenario.condition), outcome: asString(scenario.outcome) }
    }) : [],
    invalidationConditions: asStringArray(report.invalidationConditions),
    valuation: asNullableString(report.valuation), personalImpact: asNullableString(report.personalImpact),
    conditionalSuggestion: asNullableString(report.conditionalSuggestion), limitations: asStringArray(report.limitations),
    keyJudgments: Array.isArray(report.keyJudgments) ? report.keyJudgments.map((item) => {
      const judgment = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { judgment: asString(judgment.judgment), evidence: asStringArray(judgment.evidence) }
    }) : [],
  }
}

function asString(value: unknown) { return typeof value === 'string' ? value : '' }
function asNullableString(value: unknown) { return typeof value === 'string' ? value : null }
function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isFinancialFact(fact: Fact) {
  return ['reported_financial', 'derived_financial_metric', 'financial_quality_flag'].includes(fact.type)
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
