import {
  createModels, createProvider, fauxProvider, contentText, validateToolCall,
  type Api, type FauxResponseStep, type Model, type Tool,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { RuntimeSettings } from '@vibe-invest/contracts'

import {
  createPiAgentAdapter, type PiAgentAdapterMessage, type PiAgentAdapterStream,
  type PiAgentAdapterStreamFn, type PiAgentAdapterTool,
} from './agent-runtime/pi-agent-adapter.js'
import type { AnalysisReport, AnalyzeInput, ModelEvent, ModelOptions } from './model.js'
import {
  acquireActiveSlot, createActiveBudget, createConcurrencyGate, deadlineSignal, type ActiveBudget,
} from './runtime-policy.js'
import { toolRegistry } from './tool-registry.js'
import { analysisModelTools, finalizationModelTools, financialSpecialistTools } from './tools.js'

type Fact = AnalyzeInput['knownFacts'][number]
type Role = 'main' | 'fundamental'
type Stage = 'research' | 'finalization'
type ToolStatus = 'completed' | 'failed' | 'cancelled'
type ToolAudit = {
  toolCallId: string; toolName: string; status: ToolStatus
  startedAt: string | null; completedAt: string; completionOrder: number
  result: unknown; isError: boolean; notStarted?: boolean; operationId: string
}
type Batch = {
  id: string; turnIndex: number
  calls: Array<{ toolCallId: string; toolName: string; position: number; input: unknown }>
  results: Map<string, ToolAudit>
}

const unavailableToolName = 'tool_not_available'

export function createProjectedPiModel(options: ModelOptions = {}) {
  const modelGate = createConcurrencyGate()
  const toolGate = createConcurrencyGate()
  return {
    async *analyze(input: AnalyzeInput): AsyncGenerator<ModelEvent> {
      if (!input.toolRuntime) throw new Error('tool_runtime_required')
      const settings = input.runtimeSettings
      modelGate.setLimit(settings.modelConcurrency)
      toolGate.setLimit(settings.toolConcurrency)
      const runtimeMinuteMs = options.runtimeMinuteMs ?? 60_000
      const executionSignal = deadlineSignal(
        input.signal, settings.executionWallClockMinutes * runtimeMinuteMs,
        input.executionDeadlineSignal,
      )
      const activeBudget = input.activeBudget ?? createActiveBudget(
        settings.researchActiveMinutes * runtimeMinuteMs, options.activeNow,
        options.activeTimeoutSignal,
      )
      options.log?.({
        type: 'runtime_policy', modelConcurrency: settings.modelConcurrency,
        toolConcurrency: settings.toolConcurrency,
        compactionReserveTokens: settings.compactionReserveTokens,
      })
      const consumer = new AbortController()
      const agentSignal = AbortSignal.any([executionSignal, consumer.signal])
      const provider = createProviderRuntime(options)
      const queue = createAsyncQueue<ModelEvent>()
      let policyFailure: Error | undefined
      const knownFactIds = new Set(input.knownFacts.map(({ id }) => id))
      let frozenContext: Awaited<ReturnType<AnalyzeInput['fetchFinancialContext']>> | undefined
      let specialistInvocation = 0

      const loadFrozenContext = async (symbol: string) => {
        if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
          throw new Error('tool_symbol_not_allowed')
        }
        if (!frozenContext) {
          frozenContext = await input.fetchFinancialContext(symbol, executionSignal)
          for (const fact of frozenContext.facts) knownFactIds.add(fact.id)
        }
        return frozenContext
      }

      const withMainToolSlot = async <T>(
        name: string, onStart: () => Promise<void>, run: (signal: AbortSignal) => Promise<T>,
      ) => {
        const owner = await acquireActiveSlot({
          acquire: () => acquireToolSlot(input, toolGate, executionSignal),
          activeBudget, signal: executionSignal,
        })
        try {
          await onStart()
          return await run(AbortSignal.any([
            owner.signal, AbortSignal.timeout(options.toolTimeoutMs ?? 5_000),
          ]))
        } finally { owner.finish() }
      }

      const failedMainTool = (name: string, error: unknown) => {
        const id = `fact:tool-error:${name}:1`
        const timestamp = new Date().toISOString()
        const fact: Fact = {
          id, type: 'tool_error', value: 'unavailable', observedAt: timestamp,
          fetchedAt: timestamp, source: 'system', sourceReference: 'internal://tool-error',
        }
        knownFactIds.add(id)
        return { result: { error: error instanceof Error ? error.message : String(error), facts: [fact] }, isError: true }
      }

      queue.push(trace({
        type: 'system_prompt', content: input.systemPrompt,
        operationId: `execution:${input.executionId}:system-prompt`,
      }))
      if (input.runtimeContext) queue.push(trace({
        type: 'runtime_context', content: input.runtimeContext,
        operationId: `execution:${input.executionId}:runtime-context`,
      }))
      else if (input.userPrompt) queue.push(trace({
        type: 'user_input', content: input.userPrompt,
        operationId: `execution:${input.executionId}:user-input`,
      }))
      queue.push(trace({
        type: 'runtime_policy', settings,
        operationId: `execution:${input.executionId}:runtime-policy`,
      }))

      const main = runProjectedAgent({
        role: 'main', input, options, settings, executionSignal: agentSignal, activeBudget,
        onPolicyFailure: (error) => { policyFailure ??= error },
        modelGate, toolGate, provider, queue, initialTools: analysisModelTools,
        systemPrompt: input.systemPrompt,
        userPrompt: input.runtimeContext ? runtimeContextMessage(input.runtimeContext) : input.userPrompt ?? '',
        execute: async (name, params, signal, onStart) => {
          if (name === unavailableToolName) { await onStart(); return failed('tool_not_available') }
          if (name === 'fetch_financial_context') {
            const symbol = stringParam(params, 'symbol') || input.symbol
            try {
              const modelResult = await withMainToolSlot(name, onStart, async (toolSignal) => (
                toolRegistry.handler(name)!(params, {
                  loadFinancialContext: async () => {
                    if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
                      throw new Error('tool_symbol_not_allowed')
                    }
                    if (!frozenContext) {
                      frozenContext = await input.fetchFinancialContext(symbol, toolSignal)
                      for (const fact of frozenContext.facts) knownFactIds.add(fact.id)
                    }
                    return frozenContext
                  },
                })
              ))
              return succeeded(input.financialContextToolViews
                ? {
                    ...input.financialContextToolViews.retained,
                    modelProjection: input.financialContextToolViews.model,
                  }
                : modelResult)
            } catch (error) { return failedMainTool(name, error) }
          }
          if (name === 'analyze_financials') {
            const symbol = stringParam(params, 'symbol') || input.symbol
            const invocationId = `financial-specialist-${++specialistInvocation}`
            let financialContext: Awaited<ReturnType<AnalyzeInput['fetchFinancialContext']>>
            try {
              financialContext = await withMainToolSlot(name, onStart, async (toolSignal) => {
                if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
                  throw new Error('tool_symbol_not_allowed')
                }
                if (!frozenContext) {
                  frozenContext = await input.fetchFinancialContext(symbol, toolSignal)
                  for (const fact of frozenContext.facts) knownFactIds.add(fact.id)
                }
                return frozenContext
              })
            } catch (error) { return failedMainTool(name, error) }
            queue.push({
              type: 'lifecycle', status: 'waiting_for_specialists',
              operationId: `execution:${input.executionId}:specialist:${invocationId}:waiting`,
              waitTarget: '财报专项分析',
            })
            const specialist = await toolRegistry.handler(name)!(params, {
              runFinancialSpecialist: async () => runProjectedAgent({
                role: 'fundamental', input, options, settings, executionSignal: agentSignal, activeBudget,
                invocationId,
                onPolicyFailure: (error) => { policyFailure ??= error },
                modelGate, toolGate, provider, queue,
                initialTools: projectedSpecialistTools(input),
                systemPrompt: '你是独立财报分析专家。仅使用输入和投影工具中的事实；每项判断引用事实 ID，数据不足时明确说明。',
                userPrompt: JSON.stringify({
                  symbol: input.symbol, financials: financialContext.financials ?? null,
                  facts: financialContext.facts,
                }),
                execute: (toolName, toolParams, toolSignal, toolStart) => executeSpecialistTool(
                  toolName, toolParams, toolSignal, toolStart,
                  input, options, settings, activeBudget, toolGate,
                ),
              }),
            }) as Awaited<ReturnType<typeof runProjectedAgent>>
            queue.push({
              type: 'lifecycle', status: 'running_tools',
              operationId: `execution:${input.executionId}:specialist:${invocationId}:completed`,
            })
            for (const fact of specialist.facts) knownFactIds.add(fact.id)
            return succeeded({ analysis: specialist.text, facts: specialist.facts })
          }
          if (name === 'submit_analysis_report') {
            try {
              await onStart()
              return await toolRegistry.handler(name)!(params, {
                submitAnalysisReport: async (submitted) => {
                  const report = normalizeReport(submitted)
                  validateEvidence(report, knownFactIds)
                  return { ...succeeded({ submitted: true }), report, terminate: true }
                },
              }) as ExecutedTool
            } catch (error) {
              return failed(error instanceof Error ? error.message : String(error))
            }
          }
          return failed('tool_not_available')
        },
      })

      const task = main.then((outcome) => {
        if (policyFailure) throw policyFailure
        if (!outcome.report) throw new Error('report_tool_required')
        queue.push({
          type: 'completed', report: outcome.report, usage: outcome.usage,
          stopReason: outcome.stopReason, operationId: `execution:${input.executionId}:report`,
        })
      }).then(() => queue.end(), (error) => {
        if (input.signal?.aborted || consumer.signal.aborted) queue.end()
        else queue.fail(error)
      })
      try {
        for await (const event of queue) yield event
        await task
      } finally {
        consumer.abort(new Error('model_consumer_closed'))
        queue.end()
        await task.catch(() => undefined)
      }
    },
  }
}

async function runProjectedAgent(config: {
  role: Role; input: AnalyzeInput; options: ModelOptions; settings: RuntimeSettings
  executionSignal: AbortSignal; activeBudget: ActiveBudget
  modelGate: ReturnType<typeof createConcurrencyGate>; toolGate: ReturnType<typeof createConcurrencyGate>
  provider: ReturnType<typeof createProviderRuntime>; queue: ReturnType<typeof createAsyncQueue<ModelEvent>>
  initialTools: Tool[]; systemPrompt: string; userPrompt: string
  invocationId?: string
  execute: (
    name: string, params: unknown, signal: AbortSignal, onStart: () => Promise<void>,
  ) => Promise<ExecutedTool>
  onPolicyFailure: (error: Error) => void
}) {
  const { input } = config
  let stage: Stage = 'research'
  let turnIndex = 0
  let toolRounds = 0
  let finalizationAttempts = 0
  let completionOrder = 0
  let activeProjection = await input.toolRuntime!.ensureProjection({
    executionId: input.executionId, role: config.role, stage,
    tools: config.initialTools, createdAt: new Date().toISOString(),
  })
  let currentBatch: Batch | undefined
  let completedReport: AnalysisReport | undefined
  let finalText = ''
  let finalUsage: unknown
  let finalStopReason: string | undefined
  let requestPolicyFailure: Error | undefined
  let toolAuditFailure: Error | undefined
  let lastAssistantHadCalls = false
  let modelEventIndex = 0
  let textDeltaIndex = 0
  let visibleTools = [...config.initialTools]
  const callStartedAt = new Map<string, string>()
  let adapter: ReturnType<typeof createPiAgentAdapter>

  const projectedTools = () => [
    ...visibleTools.map((definition) => toAdapterTool(definition, async (callId, params, signal) => {
      let startedAt: string | undefined
      let startTask: Promise<void> | undefined
      const start = async () => {
        startTask ??= (async () => {
          const value = new Date().toISOString()
          await persistToolCallStart(callId, value)
          startedAt = value
          callStartedAt.set(callId, value)
        })().catch((error) => {
          toolAuditFailure ??= error instanceof Error ? error : new Error(String(error))
          throw error
        })
        await startTask
      }
      let executed: ExecutedTool
      let validatedParams = params
      try {
        validatedParams = validateToolCall([definition], {
          type: 'toolCall', id: callId, name: definition.name,
          arguments: params as Record<string, unknown>,
        })
      } catch { await start(); executed = failed('invalid_tool_arguments') }
      if (executed!) { /* validation failure is already normalized */ }
      else if (completedReport) executed = {
        ...failed('cancelled_after_report_submission'), terminate: true,
      }
      else if (stage === 'finalization' && config.role === 'main'
        && definition.name !== 'submit_analysis_report') executed = failed('tool_not_available')
      else if (stage === 'finalization' && config.role === 'fundamental') {
        executed = failed('tool_not_available')
      }
      else if (stage === 'research' && config.activeBudget.exhausted()) {
        executed = failed('research_active_timeout')
      }
      else try { executed = await config.execute(
        definition.name, validatedParams, signal ?? config.executionSignal, start,
      ) }
      catch (error) { executed = failed(error instanceof Error ? error.message : String(error)) }
      await start()
      const isCancelled = config.executionSignal.aborted || input.signal?.aborted
      const status: ToolStatus = isCancelled ? 'cancelled' : executed.isError ? 'failed' : 'completed'
      const audit: ToolAudit = {
        toolCallId: callId, toolName: definition.name, status, startedAt: startedAt!,
        completedAt: executed.completedAt ?? new Date().toISOString(),
        completionOrder: ++completionOrder,
        result: executed.result, isError: status !== 'completed',
        operationId: toolOperationId(config.role, input.executionId, callId, 'result'),
      }
      currentBatch?.results.set(callId, audit)
      if (executed.report) completedReport = executed.report
      return {
        content: [{
          type: 'text', text: JSON.stringify(modelToolResult(definition.name, executed.result)),
        }],
        details: { audit }, terminate: executed.terminate,
      }
    }, config.role === 'main' ? 'sequential' : undefined)),
    toAdapterTool({
      name: unavailableToolName, description: 'Unavailable tool',
      parameters: { type: 'object', additionalProperties: true },
    } as Tool, async (callId) => {
      const now = new Date().toISOString()
      callStartedAt.set(callId, now)
      await persistToolCallStart(callId, now)
      const audit: ToolAudit = {
        toolCallId: callId, toolName: unavailableToolName, status: 'failed',
        startedAt: now, completedAt: now, completionOrder: ++completionOrder,
        result: { error: 'tool_not_available', facts: [] }, isError: true,
        operationId: toolOperationId(config.role, input.executionId, callId, 'result'),
      }
      currentBatch?.results.set(callId, audit)
      return { content: [{ type: 'text', text: JSON.stringify(audit.result) }], details: { audit } }
    }),
  ]

  const persistToolCallStart = async (toolCallId: string, startedAt: string) => {
    const call = currentBatch?.calls.find((candidate) => candidate.toolCallId === toolCallId)
    if (!currentBatch || !call) throw new Error('tool_call_not_in_batch')
    const operationId = toolOperationId(config.role, input.executionId, call.toolCallId, 'call')
    await input.toolRuntime!.startToolCall({
      batchId: currentBatch.id, executionId: input.executionId,
      toolCallId: call.toolCallId, startedAt, operationId,
      eventPayload: {
        type: 'tool_call', name: call.toolName, toolCallId: call.toolCallId,
        input: call.input, startedAt, operationId,
      },
    })
    config.queue.push(trace({
      type: 'tool_call', name: call.toolName, toolCallId: call.toolCallId,
      input: call.input, startedAt, operationId,
    }))
  }

  const prepareProjection = async (tools: Tool[]) => {
    visibleTools = [...tools]
    activeProjection = await input.toolRuntime!.ensureProjection({
      executionId: input.executionId, role: config.role, stage,
      tools: visibleTools, createdAt: new Date().toISOString(),
    })
    return projectedTools()
  }

  const completeCurrentBatch = async () => {
    if (!currentBatch) return
    const batch = currentBatch
    if (batch.results.size !== batch.calls.length) {
      const now = new Date().toISOString()
      for (const call of batch.calls) if (!batch.results.has(call.toolCallId)) {
        batch.results.set(call.toolCallId, {
          ...call, status: config.executionSignal.aborted ? 'cancelled' : 'failed',
          startedAt: callStartedAt.get(call.toolCallId) ?? null, completedAt: now,
          completionOrder: ++completionOrder,
          notStarted: !callStartedAt.has(call.toolCallId),
          result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
          operationId: toolOperationId(config.role, input.executionId, call.toolCallId, 'result'),
        })
      }
    }
    await input.toolRuntime!.completeToolBatch({
      id: batch.id, executionId: input.executionId,
      results: [...batch.results.values()], completedAt: new Date().toISOString(),
    })
    for (const result of [...batch.results.values()].sort((left, right) => (
      left.completionOrder - right.completionOrder
    ))) config.queue.push(trace({
      type: 'tool_result', name: result.toolName, toolCallId: result.toolCallId,
      result: result.result,
      isError: result.isError, startedAt: result.startedAt,
      completedAt: result.completedAt, completionOrder: result.completionOrder,
      ...(result.notStarted ? { notStarted: true } : {}),
      operationId: result.operationId,
    }))
    currentBatch = undefined
  }

  adapter = createPiAgentAdapter({
    initialState: {
      systemPrompt: config.systemPrompt, model: config.provider.model,
      tools: projectedTools(),
    },
    signal: config.executionSignal,
    streamFn: async (model, context, streamOptions) => {
      const request = await beginBudgetedModelRequest(config, config.role === 'fundamental')
      try {
        turnIndex += 1
        const roleScope = config.invocationId
          ? `${config.role}:invocation:${encodeURIComponent(config.invocationId)}` : config.role
        const requestId = `execution:${input.executionId}:${roleScope}:model-attempt:${turnIndex}`
        await input.toolRuntime!.recordModelRequest({
          requestId, executionId: input.executionId, projectionId: activeProjection.id,
          turnIndex, createdAt: new Date().toISOString(),
        })
        config.queue.push(trace({
          type: 'tool_projection', projectionId: activeProjection.id, version: activeProjection.version,
          visibleToolNames: visibleTools.map(({ name }) => name),
          operationId: `${requestId}:tool-projection`,
        }))
        config.queue.push({
          type: 'lifecycle', status: stage === 'finalization' ? 'finalizing' : 'running_model',
          operationId: `${requestId}:running-model`,
        })
        const stream = await config.provider.streamFn(model, {
          ...context, tools: visibleTools.map((tool) => ({ ...tool, label: tool.name } as PiAgentAdapterTool)),
        }, { ...streamOptions, signal: request.signal })
        return finishableStream(stream, request.signal, request.finish, (error) => {
          const normalized = request.normalizeError(error)
          if (normalized instanceof Error && isPolicyFailure(normalized)) {
            requestPolicyFailure ??= normalized
            config.onPolicyFailure(normalized)
          }
          return normalized
        })
      } catch (error) { request.finish(); throw error }
    },
    afterToolCall: async ({ result, isError }) => ({
      isError: Boolean((result.details as { audit?: ToolAudit } | undefined)?.audit?.isError ?? isError),
    }),
    shouldStopAfterTurn: async () => config.role === 'main'
      ? Boolean(completedReport)
      : Boolean(finalText),
    prepareNextTurn: async () => {
      if (completedReport || finalText) return undefined
      if (lastAssistantHadCalls) toolRounds += 1
      const limit = config.role === 'main'
        ? config.settings.mainAgentToolRounds : config.settings.specialistAgentToolRounds
      if (config.activeBudget.exhausted() || toolRounds >= limit) {
        if (stage !== 'finalization') {
          stage = 'finalization'
          if (config.role === 'main') config.queue.push({
            type: 'lifecycle', status: 'budget_exhausted',
            operationId: `execution:${input.executionId}:budget-exhausted`,
          })
        }
        finalizationAttempts += 1
        if (finalizationAttempts > 2) throw new Error(
          config.role === 'main' ? 'report_tool_required' : 'specialist_finalization_required',
        )
      }
      const next = config.role === 'main'
        ? stage === 'finalization' ? finalizationModelTools : analysisModelTools
        : stage === 'finalization' ? [] : projectedSpecialistTools(input)
      return { tools: await prepareProjection(next) }
    },
    commitToolProjection: async ({ tools }) => ({ tools }),
  })

  adapter.subscribe(async (event) => {
    if (event.type === 'message_update') {
      const item = event.assistantMessageEvent
      const roleScope = config.invocationId
        ? `${config.role}:invocation:${encodeURIComponent(config.invocationId)}` : config.role
      config.queue.push(trace({
        type: 'model_event', event: compactAdapterEvent(item),
        operationId: `execution:${input.executionId}:${roleScope}:model:${turnIndex}:event:${++modelEventIndex}`,
      }))
      if (item.type === 'text_delta') config.queue.push({
        type: 'text_delta', text: item.delta,
        operationId: `execution:${input.executionId}:${roleScope}:model:${turnIndex}:text:${++textDeltaIndex}`,
      })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      finalUsage = event.message.usage
      finalStopReason = event.message.stopReason
      const calls = event.message.content.filter((content) => content.type === 'toolCall')
      lastAssistantHadCalls = calls.length > 0
      if (!calls.length) {
        if (config.role === 'fundamental') finalText = contentText(event.message.content as never)
        else adapter.followUp(userMessage(stage === 'finalization'
          ? '请立即调用 submit_analysis_report 提交受限报告。'
          : '请继续自主规划，准备好后调用 submit_analysis_report。'))
        return
      }
      const roleScope = config.invocationId
        ? `${config.role}:invocation:${encodeURIComponent(config.invocationId)}` : config.role
      const batchId = `execution:${input.executionId}:${roleScope}:model-attempt:${turnIndex}:tool-batch`
      const batch: Batch = { id: batchId, turnIndex, calls: [], results: new Map() }
      calls.forEach((call, index) => {
        const providerId = call.id || 'missing'
        call.id = config.role === 'fundamental'
          ? `${providerId}:specialist-invocation:${encodeURIComponent(config.invocationId ?? 'default')}:attempt:${turnIndex}:position:${index + 1}`
          : `${providerId}:main-attempt:${turnIndex}:position:${index + 1}`
        if (!visibleTools.some(({ name }) => name === call.name)) call.name = unavailableToolName
        batch.calls.push({
          toolCallId: call.id, toolName: call.name, position: index + 1,
          input: call.name === unavailableToolName ? {} : call.arguments,
        })
      })
      currentBatch = batch
      completionOrder = 0
      await input.toolRuntime!.beginToolBatch({
        id: batch.id, executionId: input.executionId, projectionId: activeProjection.id,
        turnIndex, calls: batch.calls, createdAt: new Date().toISOString(),
      })
      config.queue.push({
        type: 'lifecycle', status: 'running_tools',
        operationId: `${batch.id}:running-tools`,
      })
    }
    if (event.type === 'tool_execution_end' && currentBatch
      && !currentBatch.results.has(event.toolCallId)) {
      const now = new Date().toISOString()
      const result = adapterToolResult(event.result)
      const didStart = callStartedAt.has(event.toolCallId)
      currentBatch.results.set(event.toolCallId, {
        toolCallId: event.toolCallId, toolName: event.toolName,
        status: didStart
          ? config.executionSignal.aborted ? 'cancelled' : event.isError ? 'failed' : 'completed'
          : 'cancelled',
        startedAt: callStartedAt.get(event.toolCallId) ?? null, completedAt: now,
        completionOrder: ++completionOrder, result,
        isError: !didStart || config.executionSignal.aborted || event.isError,
        notStarted: !didStart,
        operationId: toolOperationId(config.role, input.executionId, event.toolCallId, 'result'),
      })
    }
    if (event.type === 'turn_end' && currentBatch) {
      if (toolAuditFailure) throw toolAuditFailure
      await completeCurrentBatch()
    }
  })

  const submitted = adapter.submit(userMessage(config.userPrompt))
  await raceAgentAbort(submitted, config.executionSignal, adapter.abort)
  if (config.executionSignal.aborted && input.signal?.aborted) {
    await submitted.catch(() => undefined)
    await completeCurrentBatch().catch(() => undefined)
    if (config.role === 'main') config.queue.push({
      type: 'cancelled', operationId: `execution:${input.executionId}:cancelled`,
    })
    adapter.dispose()
    return { report: undefined, text: '', facts: [], usage: undefined, stopReason: 'aborted' }
  }
  if (requestPolicyFailure) {
    adapter.dispose()
    throw requestPolicyFailure
  }
  await adapter.waitForIdle()
  const snapshot = adapter.snapshot()
  adapter.dispose()
  if (requestPolicyFailure) throw requestPolicyFailure
  if (toolAuditFailure) throw toolAuditFailure
  if (snapshot.errorMessage) throw new Error(snapshot.errorMessage)
  const facts = snapshot.messages.filter((message) => message.role === 'toolResult')
    .flatMap((message) => parseFacts(message))
  return {
    report: completedReport, text: finalText, facts,
    usage: finalUsage, stopReason: finalStopReason,
  }
}

type ExecutedTool = {
  result: Record<string, unknown>; isError: boolean; terminate?: boolean; report?: AnalysisReport
  completedAt?: string
}

async function executeSpecialistTool(
  name: string, params: unknown, signal: AbortSignal, onStart: () => Promise<void>, input: AnalyzeInput,
  options: ModelOptions, settings: RuntimeSettings, activeBudget: ActiveBudget,
  toolGate: ReturnType<typeof createConcurrencyGate>,
): Promise<ExecutedTool> {
  if (name === unavailableToolName) { await onStart(); return failed('tool_not_available') }
  const owner = await acquireActiveSlot({
    acquire: () => acquireToolSlot(input, toolGate, signal), activeBudget, signal,
    onStart: () => options.log?.({
      type: 'tool_request_start', executionId: input.executionId, toolName: name,
    }),
    onEnd: () => options.log?.({
      type: 'tool_request_end', executionId: input.executionId, toolName: name,
    }),
  })
  let executed: ExecutedTool
  try {
    await onStart()
    if (name === 'search_news_by_keyword') {
      if (!input.searchNews) executed = failed('tool_not_available')
      else {
      const keyword = stringParam(params, 'keyword') || input.symbol
      executed = succeeded(await toolRegistry.handler(name)!(params, {
        searchNews: async () => input.searchNews!(
          keyword, toolSignal(options, settings, owner.signal),
        ),
      }))
      }
    }
    else if (name === 'get_technical_indicators') {
      if (!input.fetchTechnicalIndicators) executed = failed('tool_not_available')
      else {
      const symbol = stringParam(params, 'symbol') || input.symbol
      const endDate = stringParam(params, 'endDate') || new Date().toISOString().slice(0, 10)
      const startDate = stringParam(params, 'startDate') || oneYearBefore(endDate)
      executed = succeeded(await toolRegistry.handler(name)!(params, {
        fetchTechnicalIndicators: async () => input.fetchTechnicalIndicators!(
          symbol, startDate, endDate, toolSignal(options, settings, owner.signal),
        ),
      }))
      }
    }
    else executed = failed('tool_not_available')
  } catch (error) {
    executed = failed(error instanceof Error ? error.message : String(error))
  } finally {
    executed!.completedAt = new Date().toISOString()
    owner.finish()
  }
  return executed!
}

function createProviderRuntime(options: ModelOptions) {
  const models = (options.modelsFactory ?? createModels)()
  let model: Model<Api>
  if (options.fauxResponses) {
    const faux = fauxProvider({ tokensPerSecond: options.fauxTokensPerSecond ?? 1000 })
    models.setProvider(faux.provider)
    faux.setResponses(options.fauxResponses as FauxResponseStep[])
    model = faux.getModel()
  } else if (options.provider && options.apiProtocol && options.modelName && options.baseUrl && options.apiKey) {
    const api = options.apiProtocol === 'responses' ? 'openai-responses' : 'openai-completions'
    const configured: Model<Api> = {
      id: options.modelName, name: options.modelName, api, provider: options.provider,
      baseUrl: options.baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 16_000,
    }
    models.setProvider(createProvider({
      id: options.provider, name: options.provider, baseUrl: options.baseUrl,
      auth: { apiKey: { name: 'provider API key', resolve: async () => ({ auth: { apiKey: options.apiKey } }) } },
      models: [configured],
      api: api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
    }))
    model = models.getModel(options.provider, options.modelName) ?? configured
  } else throw new Error('model_not_configured')
  const streamFn: PiAgentAdapterStreamFn = (selected, context, streamOptions) => models.stream(
    selected as Model<Api>, context as never,
    { signal: streamOptions?.signal, apiKey: options.apiKey },
  ) as unknown as PiAgentAdapterStream
  return { model, streamFn }
}

async function beginBudgetedModelRequest(config: {
  input: AnalyzeInput; options: ModelOptions; settings: RuntimeSettings
  executionSignal: AbortSignal; activeBudget: ActiveBudget
  modelGate: ReturnType<typeof createConcurrencyGate>
}, specialist: boolean) {
  const release = await (config.input.acquireModelSlot
    ? config.input.acquireModelSlot(config.executionSignal)
    : config.modelGate.acquire(config.executionSignal))
  let active: ReturnType<ActiveBudget['start']> | undefined
  const timeout = AbortSignal.timeout(
    config.settings.modelRequestTimeoutMinutes * (config.options.runtimeMinuteMs ?? 60_000),
  )
  try {
    active = config.activeBudget.start(config.executionSignal)
    config.options.log?.({
      type: 'model_request_start', executionId: config.input.executionId, specialist,
    })
  } catch (error) {
    try { active?.stop() } finally { release() }
    throw error
  }
  let finished = false
  return {
    signal: AbortSignal.any([
      active.signal, config.executionSignal, timeout,
    ]),
    normalizeError(error: unknown) {
      if (config.input.signal?.aborted) return config.input.signal.reason ?? error
      if (config.executionSignal.aborted
        && config.settings.executionWallClockMinutes <= config.settings.modelRequestTimeoutMinutes) {
        return new Error('execution_runtime_timeout')
      }
      if (timeout.aborted) return new Error('model_request_timeout')
      if (config.executionSignal.aborted) return new Error('execution_runtime_timeout')
      if (active.exhausted()) return new Error('research_active_timeout')
      return error
    },
    finish() {
      if (finished) return
      finished = true
      try { active.stop() } finally { release() }
      config.options.log?.({
        type: 'model_request_end', executionId: config.input.executionId, specialist,
      })
    },
  }
}

function finishableStream(
  stream: PiAgentAdapterStream, signal: AbortSignal, finish: () => void,
  normalizeError: (error: unknown) => unknown,
): PiAgentAdapterStream {
  let iterator: AsyncIterator<Awaited<ReturnType<AsyncIterator<unknown>['next']>>['value']> | undefined
  let iteratorClosed = false
  const closeIterator = () => {
    if (iteratorClosed) return undefined
    iteratorClosed = true
    return iterator?.return?.()
  }
  return {
    [Symbol.asyncIterator]() {
      try { iterator = stream[Symbol.asyncIterator]() }
      catch (error) { finish(); throw error }
      return {
        async next() {
          try {
            const item = await nextOrAbort(iterator!, signal, closeIterator)
            if (item.done) finish()
            return item as never
          }
          catch (error) {
            try {
              await closeIterator()
            } finally { finish() }
            throw normalizeError(error)
          }
        },
        async return() { try { return await closeIterator() ?? { done: true, value: undefined } as never } finally { finish() } },
      }
    },
    async result() {
      try {
        if (typeof stream.result === 'function') return await stream.result()
        throw new Error('provider_stream_result_unavailable')
      } catch (error) { throw normalizeError(error) } finally { finish() }
    },
  }
}

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>, signal: AbortSignal, closeIterator: () => unknown,
) {
  if (signal.aborted) {
    void closeIterator()
    throw signal.reason
  }
  let remove = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void closeIterator()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try { return await Promise.race([iterator.next(), aborted]) } finally { remove() }
}

function compactAdapterEvent(event: { type: string; delta?: string }) {
  if (event.type.endsWith('_delta')) return { type: event.type, delta: event.delta }
  return { type: event.type }
}

function isPolicyFailure(error: Error) {
  return ['model_request_timeout', 'execution_runtime_timeout', 'research_active_timeout']
    .includes(error.message)
}

async function raceAgentAbort(
  task: Promise<void>, signal: AbortSignal, abort: () => void,
) {
  if (signal.aborted) {
    abort()
    return
  }
  let remove = () => {}
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => {
      abort()
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try { await Promise.race([task, aborted]) } finally { remove() }
}

function toAdapterTool(
  definition: Tool, execute: PiAgentAdapterTool['execute'],
  executionMode?: 'sequential' | 'parallel',
): PiAgentAdapterTool {
  return {
    name: definition.name, label: definition.name, description: definition.description,
    parameters: { type: 'object', additionalProperties: true }, execute,
    executionMode: executionMode
      ?? (definition as Tool & { executionMode?: 'sequential' | 'parallel' }).executionMode,
  }
}

function toolOperationId(
  role: Role, executionId: string, callId: string, suffix: 'call' | 'result',
) {
  const namespace = role === 'fundamental' ? 'specialist-tool' : 'tool'
  return `execution:${executionId}:${namespace}:${callId}:${suffix}`
}

function succeeded(result: unknown): ExecutedTool {
  return { result: asRecord(result), isError: false }
}
function failed(error: string): ExecutedTool {
  return { result: { error, facts: [] }, isError: true }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : { value }
}
function modelToolResult(name: string, result: Record<string, unknown>) {
  const projection = toolRegistry.definition(name)?.modelProjection
  if (projection === 'full_result') return result
  if (projection === 'acknowledgement') {
    return { submitted: result.submitted === true, ...(result.error ? { error: result.error } : {}) }
  }
  if (result.modelProjection && typeof result.modelProjection === 'object') {
    return result.modelProjection
  }
  const allowed = [
    'facts', 'gaps', 'summary', 'analysis', 'error', 'source', 'sources',
    'cursor', 'nextCursor', 'pagination', 'truncated', 'resultCount',
  ]
  return Object.fromEntries(allowed.flatMap((key) => key in result ? [[key, result[key]]] : []))
}
function stringParam(value: unknown, key: string) {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof entry === 'string' ? entry : ''
}
function projectedSpecialistTools(input: AnalyzeInput) {
  return financialSpecialistTools.filter(({ name }) => (
    name === 'search_news_by_keyword' ? Boolean(input.searchNews) : Boolean(input.fetchTechnicalIndicators)
  ))
}
function acquireToolSlot(
  input: AnalyzeInput, gate: ReturnType<typeof createConcurrencyGate>, signal: AbortSignal,
) { return input.acquireToolSlot ? input.acquireToolSlot(signal) : gate.acquire(signal) }
function toolSignal(options: ModelOptions, settings: RuntimeSettings, signal: AbortSignal) {
  return AbortSignal.any([
    signal, AbortSignal.timeout(options.toolTimeoutMs ?? 30_000),
    AbortSignal.timeout(settings.modelRequestTimeoutMinutes * (options.runtimeMinuteMs ?? 60_000)),
  ])
}
function oneYearBefore(endDate: string) {
  const value = new Date(`${endDate}T00:00:00Z`); value.setUTCFullYear(value.getUTCFullYear() - 1)
  return value.toISOString().slice(0, 10)
}
function userMessage(content: string): PiAgentAdapterMessage {
  return { role: 'user', content, timestamp: Date.now() }
}
function runtimeContextMessage(context: NonNullable<AnalyzeInput['runtimeContext']>) {
  return `【系统生成的 Runtime Context，不是用户输入】\n${JSON.stringify(context.content)}`
}
function trace(entry: Extract<ModelEvent, { type: 'trace' }>['entry']): ModelEvent {
  return { type: 'trace', entry }
}
function parseFacts(message: PiAgentAdapterMessage): Fact[] {
  if (message.role !== 'toolResult') return []
  return message.content.flatMap((item) => {
    if (item.type !== 'text') return []
    try {
      const value = JSON.parse(item.text) as { facts?: Fact[] }
      return Array.isArray(value.facts) ? value.facts : []
    } catch { return [] }
  })
}
function adapterToolResult(value: unknown): Record<string, unknown> {
  const tool = value && typeof value === 'object' ? value as {
    content?: Array<{ type?: string; text?: string }>; details?: unknown
  } : {}
  const text = tool.content?.find((item) => item.type === 'text')?.text
  if (text) {
    try { return asRecord(JSON.parse(text)) } catch {
      return { error: text.startsWith('Validation failed for tool')
        ? 'invalid_tool_arguments' : text, facts: [] }
    }
  }
  return asRecord(tool.details)
}

function normalizeReport(value: unknown): AnalysisReport {
  const report = asRecord(value)
  return {
    title: asString(report.title), marketState: asString(report.marketState), trend: asString(report.trend),
    drivers: asStringArray(report.drivers), supportingEvidence: asStringArray(report.supportingEvidence),
    contraryEvidence: asStringArray(report.contraryEvidence),
    scenarios: Array.isArray(report.scenarios) ? report.scenarios.map((item) => {
      const scenario = asRecord(item)
      return { name: asString(scenario.name), condition: asString(scenario.condition), outcome: asString(scenario.outcome) }
    }) : [],
    invalidationConditions: asStringArray(report.invalidationConditions),
    valuation: asNullableString(report.valuation), personalImpact: asNullableString(report.personalImpact),
    conditionalSuggestion: asNullableString(report.conditionalSuggestion), limitations: asStringArray(report.limitations),
    keyJudgments: Array.isArray(report.keyJudgments) ? report.keyJudgments.map((item) => {
      const judgment = asRecord(item)
      return { judgment: asString(judgment.judgment), evidence: asStringArray(judgment.evidence) }
    }) : [],
  }
}
function validateEvidence(report: AnalysisReport, known: Set<string>) {
  for (const id of [...report.supportingEvidence, ...report.contraryEvidence,
    ...report.keyJudgments.flatMap(({ evidence }) => evidence)]) {
    if (!known.has(id)) throw new Error(`unknown_fact_id:${id}`)
  }
  for (const item of report.keyJudgments) if (!item.evidence.length) throw new Error('key_judgment_evidence_required')
}
function asString(value: unknown) { return typeof value === 'string' ? value : '' }
function asStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function asNullableString(value: unknown) { return typeof value === 'string' ? value : null }

function createAsyncQueue<T>() {
  const values: T[] = []
  const waiters: Array<(value: IteratorResult<T>) => void> = []
  let ended = false
  let failure: unknown
  return {
    push(value: T) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ done: false, value }) : values.push(value) },
    end() { if (ended) return; ended = true; while (waiters.length) waiters.shift()!({ done: true, value: undefined }) },
    fail(error: unknown) { failure = error; this.end() },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (values.length) { yield values.shift()!; continue }
        if (ended) { if (failure) throw failure; return }
        const item = await new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve))
        if (item.done) { if (failure) throw failure; return }
        yield item.value
      }
    },
  }
}
