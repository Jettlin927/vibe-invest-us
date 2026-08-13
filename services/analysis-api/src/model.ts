import {
  createProvider,
  createModels,
  fauxProvider,
  validateToolCall,
  contentText,
  type AssistantMessage,
  type Context,
  type FauxResponseStep,
  type Model,
  type Api,
  type AssistantMessageEvent,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { RuntimeSettings } from '@vibe-invest/contracts'
import {
  acquireActiveSlot, createActiveBudget, createConcurrencyGate, deadlineSignal, type ActiveBudget,
} from './runtime-policy.js'
import { analysisModelTools, finalizationModelTools, financialSpecialistTools } from './tools.js'
import { toolRegistry } from './tool-registry.js'

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
  | { type: 'system_prompt'; content: string; operationId?: string }
  | { type: 'user_input'; content: string; operationId?: string }
  | {
    type: 'runtime_policy'
    settings: RuntimeSettings
    operationId?: string
  }
  | { type: 'model_event'; event: unknown; operationId?: string }
  | { type: 'tool_call'; name: string; input: unknown; operationId: string }
  | { type: 'tool_result'; name: string; result: unknown; isError: boolean; operationId: string }
  | { type: 'cancelled'; operationId?: string }
  | { type: 'tool_projection'; projectionId: string; version: number; visibleToolNames: string[]; operationId: string }

export type ModelEvent =
  | {
    type: 'lifecycle'
    status: 'running_model' | 'running_tools' | 'waiting_for_specialists'
      | 'finalizing' | 'budget_exhausted'
    operationId: string
    waitTarget?: string
  }
  | { type: 'text_delta'; text: string; operationId?: string }
  | { type: 'trace'; entry: TraceEntry }
  | { type: 'completed'; report: AnalysisReport; usage?: unknown; stopReason?: string; operationId?: string }
  | { type: 'cancelled'; operationId?: string }

export type AnalyzeInput = {
  executionId: string
  runtimeSettings: RuntimeSettings
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
  executionDeadlineSignal?: AbortSignal
  activeBudget?: ActiveBudget
  acquireModelSlot?: (signal: AbortSignal) => Promise<() => void>
  acquireToolSlot?: (signal: AbortSignal) => Promise<() => void>
  toolRuntime?: ToolRuntime
}

export type ToolRuntime = {
  beginModelRequest(input: {
    requestId: string; executionId: string; role: 'main' | 'fundamental'
    stage: 'research' | 'finalization'; turnIndex: number; tools: Tool[]; createdAt: string
  }): Promise<{ id: string; version: number }>
  beginToolBatch(input: {
    id: string; executionId: string; projectionId: string; turnIndex: number
    calls: Array<{ toolCallId: string; toolName: string; position: number }>; createdAt: string
  }): Promise<void>
  completeToolBatch(input: {
    id: string; executionId: string; status: 'completed' | 'failed' | 'cancelled'
    results: Array<{ toolCallId: string; status: 'completed' | 'failed' | 'cancelled'; completedAt: string }>
    completedAt: string
  }): Promise<void>
}

type ModelOptions = {
  modelsFactory?: typeof createModels
  fauxResponses?: FauxResponseStep[]
  fauxTokensPerSecond?: number
  toolTimeoutMs?: number
  log?: (entry: Record<string, unknown>) => void
  provider?: string
  apiProtocol?: 'chat-completions' | 'responses'
  modelName?: string
  baseUrl?: string
  apiKey?: string
  runtimeMinuteMs?: number
  activeNow?: () => number
  activeTimeoutSignal?: (timeoutMs: number) => AbortSignal
}

export function createPiModel(options: ModelOptions = {}) {
  const modelGate = createConcurrencyGate()
  const toolGate = createConcurrencyGate()
  return {
    async *analyze(input: AnalyzeInput): AsyncGenerator<ModelEvent> {
      const runtimeSettings = input.runtimeSettings
      modelGate.setLimit(runtimeSettings.modelConcurrency)
      toolGate.setLimit(runtimeSettings.toolConcurrency)
      const runtimeMinuteMs = options.runtimeMinuteMs ?? 60_000
      const executionSignal = deadlineSignal(
        input.signal, runtimeSettings.executionWallClockMinutes * runtimeMinuteMs,
        input.executionDeadlineSignal,
      )
      const activeBudget = input.activeBudget ?? createActiveBudget(
        runtimeSettings.researchActiveMinutes * runtimeMinuteMs, options.activeNow,
        options.activeTimeoutSignal,
      )
      const models = (options.modelsFactory ?? createModels)()
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
          const owner = await acquireActiveSlot({
            acquire: () => acquireToolSlot(input, toolGate, executionSignal),
            activeBudget, signal: executionSignal,
          })
          try {
            frozenContext = await input.fetchFinancialContext(
              symbol, AbortSignal.any([owner.signal, timeoutSignal]),
            )
          } finally {
            owner.finish()
          }
          for (const fact of frozenContext.facts) knownFactIds.add(fact.id)
        }
        return frozenContext
      }
      yield { type: 'trace', entry: {
        type: 'system_prompt', content: input.systemPrompt,
        operationId: `execution:${input.executionId}:system-prompt`,
      } }
      yield { type: 'trace', entry: {
        type: 'user_input', content: input.userPrompt,
        operationId: `execution:${input.executionId}:user-input`,
      } }
      yield { type: 'trace', entry: {
        type: 'runtime_policy', settings: runtimeSettings,
        operationId: `execution:${input.executionId}:runtime-policy`,
      } }
      options.log?.({
        type: 'runtime_policy', modelConcurrency: runtimeSettings.modelConcurrency,
        toolConcurrency: runtimeSettings.toolConcurrency,
        compactionReserveTokens: runtimeSettings.compactionReserveTokens,
      })

      let modelAttempts = 0
      let toolRounds = 0
      let closing = false
      let budgetStateWritten = false
      let closingAttempts = 0
      while (true) {
        if (activeBudget.exhausted()) closing = true
        if (closing && closingAttempts >= 2) throw new Error('report_tool_required')
        if (closing) {
          if (!budgetStateWritten) {
            budgetStateWritten = true
            yield {
              type: 'lifecycle', status: 'budget_exhausted',
              operationId: `execution:${input.executionId}:budget-exhausted`,
            }
          }
          yield {
            type: 'lifecycle', status: 'finalizing',
            operationId: `execution:${input.executionId}:finalizing:${closingAttempts + 1}`,
          }
          closingAttempts += 1
          context.tools = [...finalizationModelTools]
        }
        const attemptId = `execution:${input.executionId}:model-attempt:${++modelAttempts}`
        const projection = await beginProjectedModelRequest(input, attemptId, 'main', closing
          ? 'finalization' : 'research', modelAttempts, context.tools ?? [])
        yield { type: 'trace', entry: {
          type: 'tool_projection', projectionId: projection.id, version: projection.version,
          visibleToolNames: (context.tools ?? []).map(({ name }) => name),
          operationId: `${attemptId}:tool-projection`,
        } }
        if (!closing) yield {
          type: 'lifecycle', status: 'running_model', operationId: `${attemptId}:running-model`,
        }
        let attemptEventSequence = 0
        const request = await beginModelRequest({
          input, options, runtimeSettings, executionSignal, activeBudget, modelGate,
          countActive: !closing,
        })
        let message: AssistantMessage
        let iterator: AsyncIterator<AssistantMessageEvent> | undefined
        let iteratorCompleted = false
        try {
          const stream = models.stream(
            selectedModel, context, { signal: request.signal, apiKey: options.apiKey },
          )
          iterator = stream[Symbol.asyncIterator]()
          try {
            while (true) {
              const item = await nextEvent(iterator, request.signal)
              if (item.done) { iteratorCompleted = true; break }
              const event = item.value
              const eventId = `${attemptId}:event:${++attemptEventSequence}`
              yield { type: 'trace', entry: {
                type: 'model_event', event: compactModelEvent(event), operationId: eventId,
              } }
              options.log?.({
                type: event.type,
                toolName: event.type === 'toolcall_end' ? event.toolCall.name : undefined,
              })
              if (event.type === 'text_delta') yield {
                type: 'text_delta', text: event.delta, operationId: `${eventId}:text`,
              }
            }
          } catch (error) {
            if (input.signal?.aborted) {
              yield { type: 'trace', entry: {
                type: 'cancelled', operationId: `${attemptId}:cancelled-trace`,
              } }
              yield { type: 'cancelled', operationId: `${attemptId}:cancelled` }
              return
            }
            try {
              request.assertWithinPolicy()
            } catch (policyError) {
              if (policyError instanceof Error && policyError.message === 'research_active_timeout') {
                closing = true
                continue
              }
              throw policyError
            }
            throw error
          }
          message = await stream.result()
          try {
            request.assertWithinPolicy()
          } catch (policyError) {
            if (policyError instanceof Error && policyError.message === 'research_active_timeout') {
              closing = true
              continue
            }
            throw policyError
          }
        } finally {
          request.abort()
          try {
            if (!iteratorCompleted) {
              const closing = iterator?.return?.()
              if (closing) void Promise.resolve(closing).catch(() => undefined)
            }
          } finally {
            request.finish()
          }
        }
        let runtimeWork = activeBudget.start(executionSignal)
        try {
          context.messages.push(message)
          if (message.stopReason === 'aborted') {
            runtimeWork.stop()
            yield { type: 'cancelled', operationId: `${attemptId}:cancelled` }
            return
          }
          if (message.stopReason === 'error') {
            runtimeWork.stop()
            throw new Error(message.errorMessage || 'model_error')
          }
          const calls = message.content.filter((block) => block.type === 'toolCall')
          if (!calls.length) {
            context.messages.push({
              role: 'user',
              content: '请继续自主规划。可按需使用受限工具；准备好后提交结构化报告。',
              timestamp: Date.now(),
            })
            runtimeWork.stop()
            continue
          }
          if (!closing) {
            if (toolRounds >= runtimeSettings.mainAgentToolRounds) {
              closing = true
            } else {
              toolRounds += 1
            }
          }

          const preparedCalls = prepareToolCalls(
            [...(context.tools ?? [])], calls, `execution:${input.executionId}:tool`,
            `main-attempt:${modelAttempts}`,
          )
          const batchId = `${attemptId}:tool-batch`
          await input.toolRuntime?.beginToolBatch({
            id: batchId, executionId: input.executionId, projectionId: projection.id,
            turnIndex: modelAttempts, createdAt: new Date().toISOString(),
            calls: preparedCalls.map(({ call }, index) => ({
              toolCallId: call.id, toolName: call.name, position: index + 1,
            })),
          })
          yield {
            type: 'lifecycle', status: 'running_tools',
            operationId: `${attemptId}:running-tools`,
          }
          for (const { call, toolOperationId } of preparedCalls) {
            yield { type: 'trace', entry: {
              type: 'tool_call', name: call.name, input: call.arguments,
              operationId: `${toolOperationId}:call`,
            } }
          }
          let completedReport: AnalysisReport | undefined
          let completedOperationId: string | undefined
          const batchResults: Array<{
            toolCallId: string; status: 'completed' | 'failed' | 'cancelled'; completedAt: string
          }> = []
          for (const { call, toolInput, validationError, toolOperationId } of preparedCalls) {
            if (completedReport) {
              const result = { error: 'cancelled_after_report_submission', cancelled: true, facts: [] as Fact[] }
              context.messages.push(toolResultMessage(call, result, true))
              yield { type: 'trace', entry: {
                type: 'tool_result', name: call.name, result, isError: true,
                operationId: `${toolOperationId}:result`,
              } }
              batchResults.push({ toolCallId: call.id, status: 'cancelled', completedAt: new Date().toISOString() })
              continue
            }
            const terminalError = validationError
              ? { error: validationError, facts: [] as Fact[] }
              : undefined
            if (terminalError) {
              const result = terminalError
              context.messages.push(toolResultMessage(call, result, true))
              yield { type: 'trace', entry: {
                type: 'tool_result', name: call.name, result, isError: true,
                operationId: `${toolOperationId}:result`,
              } }
              batchResults.push({ toolCallId: call.id, status: 'failed', completedAt: new Date().toISOString() })
              continue
            }
            if (call.name === 'submit_analysis_report') {
              try {
                const report = await toolRegistry.handler(call.name)?.(toolInput, {
                  submitAnalysisReport: async (params) => {
                    const candidate = normalizeReport(params)
                    validateEvidence(candidate, knownFactIds)
                    return candidate
                  },
                }) as AnalysisReport
                const result = { submitted: true }
                context.messages.push(toolResultMessage(call, result, false))
                yield { type: 'trace', entry: {
                  type: 'tool_result', name: call.name, result, isError: false,
                  operationId: `${toolOperationId}:result`,
                } }
                completedReport = report
                completedOperationId = `${toolOperationId}:report`
                batchResults.push({ toolCallId: call.id, status: 'completed', completedAt: new Date().toISOString() })
              } catch (error) {
                const result = {
                  error: error instanceof Error ? error.message : String(error),
                  instruction: '依据字段只能填写工具结果中完整、原样的事实 ID。请修正报告后重新调用 submit_analysis_report。',
                }
                context.messages.push({
                  role: 'toolResult', toolCallId: call.id, toolName: call.name,
                  content: [{ type: 'text', text: JSON.stringify(result) }], isError: true, timestamp: Date.now(),
                })
                yield { type: 'trace', entry: {
                  type: 'tool_result', name: call.name, result, isError: true,
                  operationId: `${toolOperationId}:result`,
                } }
                batchResults.push({ toolCallId: call.id, status: 'failed', completedAt: new Date().toISOString() })
              }
              continue
            }
            if (call.name !== 'fetch_financial_context' && call.name !== 'analyze_financials') {
              throw new Error(`tool_not_allowed:${call.name}`)
            }

            let result: { facts: Fact[]; [key: string]: unknown } | { error: string; facts: Fact[] }
            let isError = false
            runtimeWork.stop()
            let resumeRuntimeWork = () => {
              runtimeWork = activeBudget.start(executionSignal)
              resumeRuntimeWork = () => {}
            }
            try {
              const toolSymbol = (toolInput as { symbol?: string }).symbol ?? input.symbol
              const financialContext = await toolRegistry.handler('fetch_financial_context')?.(
                toolInput, { loadFinancialContext: async () => loadFrozenContext(toolSymbol) },
              ) as Awaited<ReturnType<AnalyzeInput['fetchFinancialContext']>>
              if (call.name === 'analyze_financials') {
                yield {
                  type: 'lifecycle', status: 'waiting_for_specialists',
                  operationId: `${toolOperationId}:waiting-for-specialist`,
                  waitTarget: '财报专项分析',
                }
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
                const specialistIterator = runFinancialSpecialist(
                  models, selectedModel, specialistContext, input, options,
                  runtimeSettings, executionSignal, activeBudget, modelGate, toolGate, call.id,
                )
                let specialist: Awaited<ReturnType<typeof specialistIterator.next>>['value']
                let specialistCompleted = false
                try {
                  let specialistStep = await specialistIterator.next()
                  while (!specialistStep.done) {
                    yield { type: 'trace', entry: specialistStep.value }
                    specialistStep = await specialistIterator.next()
                  }
                  specialist = specialistStep.value
                  specialistCompleted = true
                } finally {
                  if (!specialistCompleted) {
                    await specialistIterator.return({ analysis: '专项研究被上层终止。', facts: [] })
                  }
                }
                if (specialist.policyError === 'cancelled') {
                  yield { type: 'trace', entry: {
                    type: 'cancelled', operationId: `${toolOperationId}:specialist-cancelled-trace`,
                  } }
                  yield { type: 'cancelled', operationId: `${toolOperationId}:specialist-cancelled` }
                  return
                }
                if (specialist.policyError === 'execution_runtime_timeout') {
                  throw new Error('execution_runtime_timeout')
                }
                yield {
                  type: 'lifecycle', status: 'running_tools',
                  operationId: `${toolOperationId}:specialist-completed`,
                }
                for (const fact of specialist.facts) knownFactIds.add(fact.id)
                result = await toolRegistry.handler(call.name)?.(toolInput, {
                  runFinancialSpecialist: async () => ({
                    facts: specialist.facts, analysis: specialist.analysis,
                  }),
                }) as { facts: Fact[]; analysis: string }
              } else {
                result = financialContext
              }
              assertExecutionPolicy(input, executionSignal, activeBudget)
            } catch (error) {
              resumeRuntimeWork()
              if (executionSignal.aborted || activeBudget.exhausted()) {
                const pendingCalls = calls.slice(calls.indexOf(call))
                for (const pending of pendingCalls) {
                  const cancelledResult = policyToolResult(input, executionSignal, activeBudget)
                  context.messages.push(toolResultMessage(pending, cancelledResult, true))
                  batchResults.push({ toolCallId: pending.id, status: 'cancelled', completedAt: new Date().toISOString() })
                  yield { type: 'trace', entry: {
                    type: 'tool_result', name: pending.name, result: cancelledResult, isError: true,
                    operationId: `execution:${input.executionId}:tool:${pending.id}:result`,
                  } }
                }
                if (input.signal?.aborted) {
                  yield { type: 'trace', entry: {
                    type: 'cancelled', operationId: `${attemptId}:tool-batch-cancelled-trace`,
                  } }
                  yield { type: 'cancelled', operationId: `${attemptId}:tool-batch-cancelled` }
                  runtimeWork.stop()
                  return
                }
                if (activeBudget.exhausted()) { closing = true; break }
                throw error
              }
              isError = true
              const factId = `fact:tool-error:${call.name}:${toolRounds}`
              const timestamp = new Date().toISOString()
              const failureFact: Fact = {
                id: factId, type: 'tool_error', value: 'unavailable', observedAt: timestamp,
                fetchedAt: timestamp, source: 'system', sourceReference: 'internal://tool-error',
              }
              knownFactIds.add(factId)
              result = { error: error instanceof Error ? error.message : String(error), facts: [failureFact] }
            }
            resumeRuntimeWork()
            context.messages.push(toolResultMessage(call, result, isError))
            yield { type: 'trace', entry: {
              type: 'tool_result', name: call.name, result, isError,
              operationId: `${toolOperationId}:result`,
            } }
            batchResults.push({
              toolCallId: call.id, status: isError ? 'failed' : 'completed',
              completedAt: new Date().toISOString(),
            })
            options.log?.({ type: 'tool_result', toolName: call.name, isError })
          }
          runtimeWork.stop()
          await input.toolRuntime?.completeToolBatch({
            id: batchId, executionId: input.executionId,
            status: batchResults.some(({ status }) => status === 'cancelled') ? 'cancelled'
              : batchResults.some(({ status }) => status === 'failed') ? 'failed' : 'completed',
            results: uniqueBatchResults(batchResults), completedAt: new Date().toISOString(),
          })
          if (completedReport) {
            yield {
              type: 'lifecycle', status: 'finalizing',
              operationId: `${completedOperationId}:finalizing`,
            }
            yield {
              type: 'completed', report: completedReport,
              usage: message.usage, stopReason: message.stopReason,
              operationId: completedOperationId,
            }
            return
          }
          if (!closing && toolRounds >= runtimeSettings.mainAgentToolRounds) closing = true
        } finally {
          runtimeWork.stop()
        }
      }
    },
  }
}

async function* runFinancialSpecialist(
  models: ReturnType<typeof createModels>,
  selectedModel: Model<Api>,
  context: Context,
  input: AnalyzeInput,
  options: ModelOptions,
  runtimeSettings: RuntimeSettings,
  executionSignal: AbortSignal,
  activeBudget: ReturnType<typeof createActiveBudget>,
  modelGate: ReturnType<typeof createConcurrencyGate>,
  toolGate: ReturnType<typeof createConcurrencyGate>,
  invocationId: string,
): AsyncGenerator<TraceEntry, {
  analysis: string
  facts: Fact[]
  policyError?: 'cancelled' | 'execution_runtime_timeout'
}> {
  const facts: Fact[] = []
  const availableTools = projectedSpecialistTools(input)
  context.tools = [...availableTools]
  let toolRounds = 0
  let modelAttempts = 0
  let closing = false
  let closingAttempts = 0
  while (true) {
    modelAttempts += 1
    if (activeBudget.exhausted()) closing = true
    if (closing && closingAttempts >= 2) return { analysis: '专项研究预算已到限，未形成额外结论。', facts }
    if (closing) {
      closingAttempts += 1
      context.tools = []
    }
    const request = await beginModelRequest({
      input, options, runtimeSettings, executionSignal, activeBudget, modelGate, specialist: true,
      countActive: !closing,
    })
    const requestId = `execution:${input.executionId}:specialist:${encodeURIComponent(invocationId)}:model-attempt:${modelAttempts}`
    const projection = await beginProjectedModelRequest(
      input, requestId, 'fundamental', closing ? 'finalization' : 'research',
      modelAttempts, context.tools ?? [],
    )
    yield {
      type: 'tool_projection', projectionId: projection.id, version: projection.version,
      visibleToolNames: (context.tools ?? []).map(({ name }) => name),
      operationId: `${requestId}:tool-projection`,
    }
    let message: AssistantMessage
    try {
      message = await models.complete(selectedModel, context, {
        signal: request.signal,
        apiKey: options.apiKey,
      })
    } catch (error) {
      try {
        request.assertWithinPolicy()
      } catch (policyError) {
        if (policyError instanceof Error && policyError.message === 'research_active_timeout') {
          closing = true
          continue
        }
        throw policyError
      }
      throw error
    } finally {
      request.finish()
    }
    try {
      request.assertWithinPolicy()
    } catch (policyError) {
      if (policyError instanceof Error && policyError.message === 'research_active_timeout') {
        closing = true
        continue
      }
      throw policyError
    }
    let runtimeWork = activeBudget.start(executionSignal)
    try {
      context.messages.push(message)
      if (message.stopReason === 'error') {
        runtimeWork.stop()
        throw new Error(message.errorMessage || 'financial_specialist_error')
      }
      const calls = message.content.filter((block) => block.type === 'toolCall')
      if (!calls.length) {
        runtimeWork.stop()
        return { analysis: contentText(message.content), facts }
      }
      if (!closing) {
        if (toolRounds >= runtimeSettings.specialistAgentToolRounds) {
          closing = true
          context.tools = []
        } else {
          toolRounds += 1
        }
      }
      const preparedCalls = prepareToolCalls(
        [...(context.tools ?? [])], calls, `execution:${input.executionId}:specialist-tool`,
        `specialist-invocation:${encodeURIComponent(invocationId)}:attempt:${modelAttempts}`,
      )
      const batchId = `${requestId}:tool-batch`
      await input.toolRuntime?.beginToolBatch({
        id: batchId, executionId: input.executionId, projectionId: projection.id,
        turnIndex: modelAttempts, createdAt: new Date().toISOString(),
        calls: preparedCalls.map(({ call }, index) => ({
          toolCallId: call.id, toolName: call.name, position: index + 1,
        })),
      })
      const batchResults: Array<{
        toolCallId: string; status: 'completed' | 'failed' | 'cancelled'; completedAt: string
      }> = []
      for (const { call, toolOperationId } of preparedCalls) {
        yield {
          type: 'tool_call', name: call.name, input: call.arguments,
          operationId: `${toolOperationId}:call`,
        }
      }
      for (const { call, toolInput, validationError, toolOperationId } of preparedCalls) {
        const terminalError = validationError
          ? { error: validationError, facts: [] as Fact[] }
          : undefined
        if (terminalError) {
          const result = terminalError
          context.messages.push(toolResultMessage(call, result, true))
          yield {
            type: 'tool_result', name: call.name, result, isError: true,
            operationId: `${toolOperationId}:result`,
          }
          batchResults.push({ toolCallId: call.id, status: 'failed', completedAt: new Date().toISOString() })
          continue
        }
        let result: { facts: Fact[]; [key: string]: unknown }
        let isError = false
        runtimeWork.stop()
        let toolOwner: Awaited<ReturnType<typeof acquireActiveSlot>> | undefined
        try {
          toolOwner = await acquireActiveSlot({
            acquire: () => acquireToolSlot(input, toolGate, executionSignal),
            activeBudget, signal: executionSignal,
            onStart: () => options.log?.({
              type: 'tool_request_start', executionId: input.executionId, toolName: call.name,
            }),
            onEnd: () => options.log?.({
              type: 'tool_request_end', executionId: input.executionId, toolName: call.name,
            }),
          })
          if (call.name === 'search_news_by_keyword') {
            if (!input.searchNews) throw new Error('news_search_unavailable')
            const keyword = (toolInput as { keyword?: string }).keyword ?? input.symbol
            result = await toolRegistry.handler(call.name)?.(toolInput, {
              searchNews: async () => input.searchNews!(keyword, toolSignal(
                input, options, runtimeSettings, toolOwner!.signal,
              )),
            }) as { facts: Fact[]; [key: string]: unknown }
          } else if (call.name === 'get_technical_indicators') {
            if (!input.fetchTechnicalIndicators) throw new Error('technical_indicators_unavailable')
            const values = toolInput as { symbol?: string; startDate?: string; endDate?: string }
            const endDate = values.endDate ?? new Date().toISOString().slice(0, 10)
            const startDate = values.startDate ?? oneYearBefore(endDate)
            result = await toolRegistry.handler(call.name)?.(toolInput, {
              fetchTechnicalIndicators: async () => input.fetchTechnicalIndicators!(
                values.symbol ?? input.symbol, startDate, endDate,
                toolSignal(input, options, runtimeSettings, toolOwner!.signal),
              ),
            }) as { facts: Fact[]; [key: string]: unknown }
          } else {
            throw new Error(`tool_not_allowed:${call.name}`)
          }
          assertExecutionPolicy(input, executionSignal, activeBudget)
          facts.push(...result.facts)
        } catch (error) {
          if (executionSignal.aborted || toolOwner?.exhausted() || activeBudget.exhausted()) {
            for (const pending of calls.slice(calls.indexOf(call))) {
              const cancelledResult = policyToolResult(input, executionSignal, activeBudget)
              context.messages.push(toolResultMessage(pending, cancelledResult, true))
              batchResults.push({ toolCallId: pending.id, status: 'cancelled', completedAt: new Date().toISOString() })
              yield {
                type: 'tool_result', name: pending.name, result: cancelledResult, isError: true,
                operationId: `execution:${input.executionId}:specialist-tool:${pending.id}:result`,
              }
            }
            if (input.signal?.aborted) {
              return {
                analysis: '专项研究已取消。', facts,
                policyError: 'cancelled' as const,
              }
            }
            if (executionSignal.aborted && !activeBudget.exhausted()) {
              return {
                analysis: '专项研究超过 execution wall。', facts,
                policyError: 'execution_runtime_timeout' as const,
              }
            }
            closing = true
            break
          }
          isError = true
          result = { error: error instanceof Error ? error.message : String(error), facts: [] }
        } finally {
          toolOwner?.finish()
        }
        runtimeWork = activeBudget.start(executionSignal)
        context.messages.push(toolResultMessage(call, result, isError))
        yield {
          type: 'tool_result', name: call.name, result, isError,
          operationId: `${toolOperationId}:result`,
        }
        batchResults.push({
          toolCallId: call.id, status: isError ? 'failed' : 'completed', completedAt: new Date().toISOString(),
        })
      }
      runtimeWork.stop()
      await input.toolRuntime?.completeToolBatch({
        id: batchId, executionId: input.executionId,
        status: batchResults.some(({ status }) => status === 'cancelled') ? 'cancelled'
          : batchResults.some(({ status }) => status === 'failed') ? 'failed' : 'completed',
        results: uniqueBatchResults(batchResults), completedAt: new Date().toISOString(),
      })
      if (toolRounds >= runtimeSettings.specialistAgentToolRounds) closing = true
    } finally {
      runtimeWork.stop()
    }
  }
}

function prepareToolCalls(
  tools: Tool[], calls: ToolCall[], operationPrefix: string, turnId: string,
) {
  return calls.map((call, index) => {
    const providerId = call.id || 'missing'
    const runtimeId = `${providerId}:${turnId}:position:${index + 1}`
    call.id = runtimeId
    const prepared = {
      call,
      toolInput: undefined as unknown,
      validationError: undefined as 'tool_not_available' | 'invalid_tool_arguments' | undefined,
      toolOperationId: `${operationPrefix}:${runtimeId}`,
    }
    if (!tools.some(({ name }) => name === call.name)) {
      prepared.validationError = 'tool_not_available'
      return prepared
    }
    try {
      prepared.toolInput = validateToolCall(tools, call)
    } catch {
      prepared.validationError = 'invalid_tool_arguments'
    }
    return prepared
  })
}

async function beginProjectedModelRequest(
  input: AnalyzeInput, requestId: string, role: 'main' | 'fundamental',
  stage: 'research' | 'finalization', turnIndex: number, tools: Tool[],
) {
  return input.toolRuntime?.beginModelRequest({
    requestId, executionId: input.executionId, role, stage, turnIndex, tools,
    createdAt: new Date().toISOString(),
  }) ?? { id: `${requestId}:ephemeral-projection`, version: turnIndex }
}

function uniqueBatchResults<T extends { toolCallId: string }>(results: T[]) {
  return [...new Map(results.map((result) => [result.toolCallId, result])).values()]
}

function projectedSpecialistTools(input: AnalyzeInput) {
  return financialSpecialistTools.filter(({ name }) => (
    name === 'search_news_by_keyword' ? Boolean(input.searchNews) : Boolean(input.fetchTechnicalIndicators)
  ))
}

function assertExecutionPolicy(
  input: AnalyzeInput, executionSignal: AbortSignal, activeBudget: ActiveBudget,
) {
  if (input.signal?.aborted) throw input.signal.reason
  if (executionSignal.aborted) throw new Error('execution_runtime_timeout')
  if (activeBudget.exhausted()) throw new Error('research_active_timeout')
}

function policyToolResult(
  input: AnalyzeInput, executionSignal: AbortSignal, activeBudget: ActiveBudget,
) {
  const error = input.signal?.aborted
    ? 'cancelled'
    : executionSignal.aborted && !activeBudget.exhausted()
      ? 'execution_runtime_timeout'
      : 'research_active_timeout'
  return { error, cancelled: true, facts: [] as Fact[] }
}

function toolResultMessage(
  call: { id: string; name: string }, result: unknown, isError: boolean,
) {
  return {
    role: 'toolResult' as const, toolCallId: call.id, toolName: call.name,
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError, timestamp: Date.now(),
  }
}

async function beginModelRequest(input: {
  input: AnalyzeInput
  options: ModelOptions
  runtimeSettings: RuntimeSettings
  executionSignal: AbortSignal
  activeBudget: ReturnType<typeof createActiveBudget>
  modelGate: ReturnType<typeof createConcurrencyGate>
  specialist?: boolean
  countActive: boolean
}) {
  const release = await (input.input.acquireModelSlot
    ? input.input.acquireModelSlot(input.executionSignal)
    : input.modelGate.acquire(input.executionSignal))
  const owner = new AbortController()
  let active: ReturnType<ActiveBudget['start']> | undefined
  try {
    const timeout = AbortSignal.timeout(
      input.runtimeSettings.modelRequestTimeoutMinutes * (input.options.runtimeMinuteMs ?? 60_000),
    )
    active = input.countActive ? input.activeBudget.start(input.executionSignal) : undefined
    input.options.log?.({
      type: 'model_request_start', executionId: input.input.executionId,
      specialist: input.specialist,
    })
    let finished = false
    return {
      signal: AbortSignal.any([
        ...(active ? [active.signal] : []), input.executionSignal, timeout, owner.signal,
      ]),
      assertWithinPolicy() {
        if (timeout.aborted) throw new Error('model_request_timeout')
        if (input.executionSignal.aborted && !input.input.signal?.aborted) {
          throw new Error('execution_runtime_timeout')
        }
        if (active?.exhausted()) throw new Error('research_active_timeout')
      },
      abort() {
        if (!owner.signal.aborted) owner.abort(new Error('model_request_closed'))
      },
      finish() {
        if (finished) return
        finished = true
        if (!owner.signal.aborted) owner.abort(new Error('model_request_closed'))
        try {
          input.options.log?.({
            type: 'model_request_end', executionId: input.input.executionId,
            specialist: input.specialist,
          })
        } finally {
          active?.stop()
          release()
        }
      },
    }
  } catch (error) {
    try {
      active?.stop()
    } finally {
      release()
    }
    throw error
  }
}

function toolSignal(
  input: AnalyzeInput, options: ModelOptions, runtimeSettings: RuntimeSettings,
  activeSignal: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(options.toolTimeoutMs ?? 30_000)
  const requestTimeout = AbortSignal.timeout(
    runtimeSettings.modelRequestTimeoutMinutes * (options.runtimeMinuteMs ?? 60_000),
  )
  return AbortSignal.any([activeSignal, timeoutSignal, requestTimeout])
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

function acquireToolSlot(
  input: AnalyzeInput, gate: ReturnType<typeof createConcurrencyGate>,
  signal: AbortSignal,
) {
  return input.acquireToolSlot?.(signal) ?? gate.acquire(signal)
}
