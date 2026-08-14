import {
  createModels, createProvider, fauxProvider, contentText, validateToolCall,
  type Api, type FauxResponseStep, type Model, type Tool,
} from '@earendil-works/pi-ai'
import { createHash, randomUUID } from 'node:crypto'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { RuntimeSettings } from '@vibe-invest/contracts'

import {
  createPiAgentAdapter, type PiAgentAdapterMessage, type PiAgentAdapterStream,
  type PiAgentAdapterStreamFn, type PiAgentAdapterTool,
  type PiAgentAdapterUsage,
} from './agent-runtime/pi-agent-adapter.js'
import type {
  AnalysisReport, AnalyzeFundamentalInput, AnalyzeInput, AnalyzeNewsInput, AnalyzeTechnicalInput,
  ModelEvent, ModelOptions,
} from './model.js'
import {
  acquireActiveSlot, createActiveBudget, createConcurrencyGate, deadlineSignal, raceWithAbort,
  type ActiveBudget,
} from './runtime-policy.js'
import { toolRegistry } from './tool-registry.js'
import {
  analysisModelTools, finalizationModelTools, financialSpecialistTools, newsSpecialistTools,
  technicalSpecialistTools,
} from './tools.js'
import { validateReportCandidate } from './report-validation.js'

type Fact = AnalyzeInput['knownFacts'][number]
type Role = 'main' | 'fundamental' | 'news' | 'technical'
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

class CompactionGenerationError extends Error {
  readonly usage: unknown
  constructor(cause: unknown, usage: unknown = null) {
    super('compaction_generation_failed', { cause })
    this.usage = usage
  }
}

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
      const knownFacts = new Map(input.knownFacts.map((fact) => [fact.id, fact]))
      const rememberFacts = (facts: Fact[]) => {
        for (const fact of facts) knownFacts.set(fact.id, fact)
      }
      let frozenContext: Awaited<ReturnType<AnalyzeInput['fetchFinancialContext']>> | undefined
      let newsDecisionRecorded = false
      let fundamentalDecisionRecorded = false
      let technicalDecisionRecorded = false
      const preparedSpecialists = new Map<string, {
        sessionId: string; executionId: string; created: boolean
      }>()
      const specialistOutcomes = new Map<string, Record<string, unknown>>(
        input.priorSpecialistOutcomes?.map(({ domain, outcome }) => [domain, outcome]) ?? [],
      )
      const rememberSpecialistOutcome = (
        domain: 'news' | 'fundamental_valuation' | 'technical', outcome: Record<string, unknown>,
      ) => {
        specialistOutcomes.set(domain, outcome)
        input.onSpecialistOutcome?.(domain, outcome)
      }
      if (!input.runNewsSpecialist && !specialistOutcomes.has('news')) rememberSpecialistOutcome('news', {
        launched: false, status: 'not_started', reason: 'news_specialist_runtime_unavailable',
      })
      if (!input.runFundamentalSpecialist && !specialistOutcomes.has('fundamental_valuation')) {
        rememberSpecialistOutcome('fundamental_valuation', {
        launched: false, status: 'not_started', reason: 'fundamental_specialist_runtime_unavailable',
        })
      }
      if (!input.runTechnicalSpecialist && !specialistOutcomes.has('technical')) rememberSpecialistOutcome('technical', {
        launched: false, status: 'not_started', reason: 'technical_specialist_runtime_unavailable',
      })
      const reportValidationState = { failures: 0, exhausted: false }

      const loadFrozenContext = async (symbol: string) => {
        if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
          throw new Error('tool_symbol_not_allowed')
        }
        if (!frozenContext) {
          frozenContext = await input.fetchFinancialContext(symbol, executionSignal)
          rememberFacts(frozenContext.facts)
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
          const signal = AbortSignal.any([
            owner.signal, AbortSignal.timeout(options.toolTimeoutMs ?? 5_000),
          ])
          return await raceWithAbort(() => run(signal), signal)
        } finally { owner.finish() }
      }

      const failedMainTool = (name: string, error: unknown) => {
        const id = `fact:tool-error:${name}:1`
        const timestamp = new Date().toISOString()
        const fact: Fact = {
          id, type: 'tool_error', value: 'unavailable', observedAt: timestamp,
          fetchedAt: timestamp, source: 'system', sourceReference: 'internal://tool-error',
        }
        knownFacts.set(id, fact)
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
      if (input.runtimeFollowUp) queue.push(trace({
        type: 'runtime_follow_up', content: input.runtimeFollowUp,
        operationId: `execution:${input.executionId}:runtime-follow-up`,
      }))
      else if (input.userPrompt) queue.push(trace({
        type: 'user_input', content: input.userPrompt,
        operationId: `execution:${input.executionId}:user-input`,
      }))
      queue.push(trace({
        type: 'runtime_policy', settings,
        operationId: `execution:${input.executionId}:runtime-policy`,
      }))

      const ordinaryFollowUp = Boolean(input.runtimeFollowUp
        && input.runtimeFollowUp.content.updateReport !== true)
      const followUpResearchTools = ordinaryFollowUp
        ? analysisModelTools.filter(({ name }) => name !== 'submit_analysis_report')
        : analysisModelTools
      const main = runProjectedAgent({
        role: 'main', input, options, settings, executionSignal: agentSignal, activeBudget,
        onPolicyFailure: (error) => { policyFailure ??= error },
        modelGate, toolGate, provider, queue,
        initialTools: input.finalizationOnly ? finalizationModelTools : followUpResearchTools,
        initialStage: input.finalizationOnly ? 'finalization' : 'research',
        nextResearchTools: () => followUpResearchTools,
        nextFinalizationTools: () => ordinaryFollowUp ? [] : finalizationModelTools,
        systemPrompt: input.systemPrompt,
        userPrompt: input.runtimeFollowUp
          ? [input.runtimeFollowUp.content.message, runtimeFollowUpMessage(input.runtimeFollowUp),
              input.runtimeResume ? runtimeResumeMessage(input.runtimeResume) : '']
              .filter(Boolean).join('\n')
          : input.runtimeContext
          ? [runtimeContextMessage(input.runtimeContext), input.runtimeResume
            ? runtimeResumeMessage(input.runtimeResume) : ''].filter(Boolean).join('\n')
          : input.userPrompt ?? '',
        shouldRejectNextTurn: () => reportValidationState.exhausted,
        prepareSpecialistBatch: input.prepareSpecialistBatch ? async (calls, batchId) => {
          const domainByTool = {
            run_news_analysis: 'news', run_fundamental_analysis: 'fundamental_valuation',
            run_technical_analysis: 'technical',
          } as const
          const requests = calls.flatMap((call) => {
            const domain = domainByTool[call.toolName as keyof typeof domainByTool]
            if (!domain) return []
            let params: Record<string, unknown>
            try {
              params = asRecord(validateToolCall([toolRegistry.definition(call.toolName)!.model], {
                type: 'toolCall', id: call.toolCallId, name: call.toolName,
                arguments: asRecord(call.input),
              }))
            } catch { return [] }
            return domain && params.launch === true ? [{
              domain, researchQuestion: asString(params.researchQuestion), reason: asString(params.reason),
            }] : []
          })
          if (!requests.length) return []
          const prepared = await input.prepareSpecialistBatch!(requests, batchId)
          for (const item of prepared) preparedSpecialists.set(item.domain, item)
          return prepared.map(({ sessionId }) => sessionId)
        } : undefined,
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
                      rememberFacts(frozenContext.facts)
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
          if (name === 'run_fundamental_analysis') {
            await onStart()
            fundamentalDecisionRecorded = true
            const request = asRecord(params) as {
              launch?: unknown; researchQuestion?: unknown; reason?: unknown
            }
            const reason = asString(request.reason)
            const researchQuestion = asString(request.researchQuestion)
            if (request.launch !== true) {
              const result = { launched: false, status: 'not_started', reason, researchQuestion }
              rememberSpecialistOutcome('fundamental_valuation', result)
              return succeeded(result)
            }
            if (!input.runFundamentalSpecialist) return failed('fundamental_specialist_runtime_unavailable')
            const prepared = preparedSpecialists.get('fundamental_valuation')
            const result = await input.runFundamentalSpecialist({
              launch: true, researchQuestion, reason, ...(prepared ? { prepared } : {}),
            })
            rememberSpecialistOutcome('fundamental_valuation', result)
            return succeeded(result)
          }
          if (name === 'run_news_analysis') {
            await onStart()
            newsDecisionRecorded = true
            const request = asRecord(params) as {
              launch?: unknown; researchQuestion?: unknown; reason?: unknown
            }
            const reason = asString(request.reason)
            const researchQuestion = asString(request.researchQuestion)
            if (request.launch !== true) {
              const result = { launched: false, status: 'not_started', reason, researchQuestion }
              rememberSpecialistOutcome('news', result)
              return succeeded(result)
            }
            if (!input.runNewsSpecialist) return failed('news_specialist_runtime_unavailable')
            const prepared = preparedSpecialists.get('news')
            const result = await input.runNewsSpecialist({
              launch: true, researchQuestion, reason, ...(prepared ? { prepared } : {}),
            })
            rememberSpecialistOutcome('news', result)
            return succeeded(result)
          }
          if (name === 'run_technical_analysis') {
            await onStart()
            technicalDecisionRecorded = true
            const request = asRecord(params) as {
              launch?: unknown; researchQuestion?: unknown; reason?: unknown
            }
            const reason = asString(request.reason)
            const researchQuestion = asString(request.researchQuestion)
            if (request.launch !== true) {
              const result = { launched: false, status: 'not_started', reason, researchQuestion }
              rememberSpecialistOutcome('technical', result)
              return succeeded(result)
            }
            if (!input.runTechnicalSpecialist) return failed('technical_specialist_runtime_unavailable')
            const prepared = preparedSpecialists.get('technical')
            const result = await input.runTechnicalSpecialist({
              launch: true, researchQuestion, reason, ...(prepared ? { prepared } : {}),
            })
            rememberSpecialistOutcome('technical', result)
            return succeeded(result)
          }
          if (name === 'submit_analysis_report') {
            try {
              await onStart()
              if (input.runNewsSpecialist && !newsDecisionRecorded) {
                return failed('news_specialist_decision_required')
              }
              if (input.runFundamentalSpecialist && !fundamentalDecisionRecorded) {
                return failed('fundamental_specialist_decision_required')
              }
              if (input.runTechnicalSpecialist && !technicalDecisionRecorded) {
                return failed('technical_specialist_decision_required')
              }
              return await toolRegistry.handler(name)!(params, {
                submitAnalysisReport: async (submitted) => {
                  if (input.refreshKnownFacts) rememberFacts(await input.refreshKnownFacts())
                  const validation = validateReportCandidate(submitted, {
                    role: 'main', knownFacts: [...knownFacts.values()],
                    specialistStatuses: [...specialistOutcomes].map(([domain, outcome]) => ({
                      domain: domain as 'news' | 'fundamental_valuation' | 'technical',
                      status: asString(outcome.status),
                    })),
                    specialistReports: [...specialistOutcomes].flatMap(([domain, outcome]) => (
                      typeof outcome.sessionId === 'string' && typeof outcome.reportId === 'string'
                      && typeof outcome.reportVersion === 'number'
                      && ['completed', 'partial'].includes(asString(outcome.status)) ? [{
                          domain: domain as 'news' | 'fundamental_valuation' | 'technical',
                          sessionId: outcome.sessionId, reportId: outcome.reportId,
                          version: outcome.reportVersion,
                          status: asString(outcome.status) as 'completed' | 'partial',
                        }] : []
                    )),
                  })
                  if (!validation.ok) {
                    reportValidationState.failures += 1
                    if (reportValidationState.failures >= 3) reportValidationState.exhausted = true
                    return failedReportValidation(validation.errors, submitted)
                  }
                  const report = legacyReport(validation.report)
                  return {
                    ...succeeded({ submitted: true }), report,
                    reportVersion: { kind: validation.report.kind, report: validation.report },
                    terminate: true,
                  }
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
        if (input.runtimeFollowUp && input.runtimeFollowUp.content.updateReport !== true
          && !outcome.report) {
          queue.push({
            type: 'chat_completed', text: outcome.text, usage: outcome.usage,
            stopReason: outcome.stopReason,
            operationId: `execution:${input.executionId}:chat-completed`,
          })
          return
        }
        if (!outcome.report) throw new Error('report_tool_required')
        queue.push({
          type: 'completed', report: outcome.report, usage: outcome.usage,
          reportVersion: outcome.reportVersion,
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
    async *analyzeNews(input: AnalyzeNewsInput): AsyncGenerator<ModelEvent> {
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
      const consumer = new AbortController()
      const agentSignal = AbortSignal.any([executionSignal, consumer.signal])
      const provider = createProviderRuntime(options)
      const queue = createAsyncQueue<ModelEvent>()
      const knownFacts = new Map(input.knownFacts.map((fact) => [fact.id, fact]))
      const candidateFactIds = new Set<string>()
      const regularCandidateFactIds = new Set<string>()
      for (const reusable of input.runtimeResume?.content.reusableToolResults ?? []) {
        if (!['search_news_candidates', 'search_web_evidence'].includes(reusable.toolName)) continue
        for (const factId of reusable.factIds) {
          if (!knownFacts.has(factId)) continue
          candidateFactIds.add(factId)
          if (reusable.toolName === 'search_news_candidates') regularCandidateFactIds.add(factId)
        }
      }
      let webSearchEligible = false
      let webSearchQuery = ''
      let webSearchDecisionIndex = 0
      let pendingWebSearchDecision: Extract<ModelEvent, { type: 'trace' }>['entry'] | undefined
      const validationState = { failures: 0, exhausted: false }
      let policyFailure: Error | undefined
      queue.push(trace({
        type: 'system_prompt', content: input.systemPrompt,
        operationId: `execution:${input.executionId}:system-prompt`,
      }))
      queue.push(trace({
        type: 'user_input', content: input.researchQuestion,
        operationId: `execution:${input.executionId}:research-question`,
      }))
      const runTool = async (
        name: string, onStart: () => Promise<void>, signal: AbortSignal,
        task: (toolSignal: AbortSignal) => Promise<unknown>,
      ) => {
        const owner = await acquireActiveSlot({
          acquire: () => input.acquireToolSlot
            ? input.acquireToolSlot(signal) : toolGate.acquire(signal),
          activeBudget, signal,
        })
        try {
          await onStart()
          const signal = toolSignal(options, settings, owner.signal)
          const result = await raceWithAbort(() => task(signal), signal)
          const facts = asRecord(result).facts
          if (Array.isArray(facts)) for (const fact of facts as Fact[]) knownFacts.set(fact.id, fact)
          return succeeded(result)
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error))
        } finally { owner.finish() }
      }
      const news = runProjectedAgent({
        role: 'news', input, options, settings, executionSignal: agentSignal, activeBudget,
        onPolicyFailure: (error) => { policyFailure ??= error }, modelGate, toolGate,
        provider, queue, initialTools: newsSpecialistTools,
        systemPrompt: input.systemPrompt, userPrompt: specialistUserPrompt(input),
        shouldRejectNextTurn: () => validationState.exhausted,
        nextResearchTools: () => webSearchEligible
          ? [...newsSpecialistTools, toolRegistry.definition('search_web_evidence')!.model]
          : newsSpecialistTools,
        beforeNextProjection: () => {
          const decision = pendingWebSearchDecision
          pendingWebSearchDecision = undefined
          return decision
        },
        execute: async (name, params, signal, onStart) => {
          if (name === unavailableToolName) { await onStart(); return failed('tool_not_available') }
          if (name === 'search_news_candidates') {
            const query = stringParam(params, 'query')
            const result = await runTool(name, onStart, signal, (toolSignal) => (
              input.searchNewsCandidates(query, toolSignal)
            ))
            const facts = asRecord(result.result).facts
            if (Array.isArray(facts)) for (const fact of facts as Fact[]) {
              candidateFactIds.add(fact.id); regularCandidateFactIds.add(fact.id)
            }
            const eligibility = asRecord(asRecord(result.result).eligibility)
            const reasons = Array.isArray(eligibility.reasons)
              ? eligibility.reasons as Array<{ source: string; reason: string }> : []
            webSearchEligible = validWebSearchReasons(reasons)
            webSearchQuery = asString(eligibility.normalizedQuery) || query
            pendingWebSearchDecision = {
              type: 'web_search_eligibility', query: webSearchQuery,
              eligible: webSearchEligible, reasons,
              operationId: `execution:${input.executionId}:web-search-eligibility:${++webSearchDecisionIndex}`,
            }
            return result
          }
          if (name === 'search_web_evidence') {
            const query = stringParam(params, 'query')
            if (!webSearchEligible || normalizeQuery(query) !== normalizeQuery(webSearchQuery)
              || !input.searchWebEvidence) {
              await onStart(); return failed('tool_not_available')
            }
            const result = await runTool(name, onStart, signal, (toolSignal) => (
              input.searchWebEvidence!(query, toolSignal)
            ))
            const facts = asRecord(result.result).facts
            if (Array.isArray(facts)) for (const fact of facts as Fact[]) candidateFactIds.add(fact.id)
            return result
          }
          if (name === 'read_news_document') {
            const factId = stringParam(params, 'factId')
            const candidate = knownFacts.get(factId)
            if (!candidate || !candidateFactIds.has(factId)) {
              await onStart(); return failed('news_candidate_not_found')
            }
            const result = await runTool(name, onStart, signal, (toolSignal) => (
              input.readNewsDocument(candidate, toolSignal)
            ))
            const verifiedFacts = asRecord(result.result).facts
            if (regularCandidateFactIds.has(factId) && Array.isArray(verifiedFacts)
              && (verifiedFacts as Fact[]).some((fact) => fact.evidenceLevel === 'verified_news')) {
              webSearchEligible = false
              pendingWebSearchDecision = {
                type: 'web_search_eligibility', query: webSearchQuery,
                eligible: false, reasons: [{ source: candidate.source, reason: 'qualified' }],
                operationId: `execution:${input.executionId}:web-search-eligibility:${++webSearchDecisionIndex}`,
              }
            }
            return result.isError ? result : {
              ...result,
              result: {
                facts: result.result.facts, sources: result.result.sources,
                modelProjection: result.result,
              },
            }
          }
          if (name === 'list_company_events') {
            const symbol = stringParam(params, 'symbol') || input.symbol
            if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
              await onStart(); return failed('tool_symbol_not_allowed')
            }
            return runTool(name, onStart, signal, (toolSignal) => (
              input.listCompanyEvents(symbol, toolSignal)
            ))
          }
          if (name === 'submit_specialist_report') {
            await onStart()
            const validation = validateReportCandidate(params, {
              role: 'news', knownFacts: [...knownFacts.values()],
            })
            if (!validation.ok) {
              validationState.failures += 1
              if (validationState.failures >= 3) validationState.exhausted = true
              return failedReportValidation(validation.errors, params)
            }
            return {
              ...succeeded({ submitted: true }), report: legacyReport(validation.report),
              reportVersion: { kind: 'specialist', report: validation.report }, terminate: true,
            }
          }
          return failed('tool_not_available')
        },
      })
      const task = news.then((outcome) => {
        if (policyFailure) throw policyFailure
        if (!outcome.report || !outcome.reportVersion) throw new Error('specialist_report_required')
        queue.push({
          type: 'completed', report: outcome.report, reportVersion: outcome.reportVersion,
          usage: outcome.usage, stopReason: outcome.stopReason,
          operationId: `execution:${input.executionId}:report`,
        })
      }).then(() => queue.end(), (error) => queue.fail(error))
      try {
        for await (const event of queue) yield event
        await task
      } finally {
        consumer.abort(new Error('model_consumer_closed'))
        queue.end()
        await task.catch(() => undefined)
      }
    },
    async *analyzeFundamental(input: AnalyzeFundamentalInput): AsyncGenerator<ModelEvent> {
      yield* runStructuredSpecialist({
        input, role: 'fundamental', validationRole: 'fundamental_valuation',
        initialTools: financialSpecialistTools,
        executeDomainTool: (name, params, symbol, runTool) => {
          if (name === 'get_financial_overview') return runTool(
            (toolSignal) => input.getFinancialOverview(symbol, toolSignal),
          )
          if (name === 'get_financial_metric_series') return runTool(
            (toolSignal) => input.getFinancialMetricSeries(
              symbol, stringParam(params, 'metric'), stringParam(params, 'cursor') || undefined, toolSignal,
            ),
          )
          if (name === 'get_valuation_evidence') return runTool(
            (toolSignal) => input.getValuationEvidence(symbol, toolSignal),
          )
          if (name === 'read_filing_document') return runTool(
            (toolSignal) => input.readFilingDocument(
              symbol, stringParam(params, 'filingId'), stringParam(params, 'cursor') || undefined, toolSignal,
            ),
          )
          if (name === 'list_company_events') return runTool(
            (toolSignal) => input.listCompanyEvents(symbol, toolSignal),
          )
        },
      }, options, modelGate, toolGate)
    },
    async *analyzeTechnical(input: AnalyzeTechnicalInput): AsyncGenerator<ModelEvent> {
      yield* runStructuredSpecialist({
        input, role: 'technical', validationRole: 'technical', initialTools: technicalSpecialistTools,
        executeDomainTool: (name, params, symbol, runTool) => {
          if (name === 'get_technical_evidence') return runTool(
            (toolSignal) => input.getTechnicalEvidence(symbol, toolSignal),
          )
          if (name === 'get_price_window') return runTool(
            (toolSignal) => input.getPriceWindow(
              symbol, stringParam(params, 'startDate'), stringParam(params, 'endDate'),
              stringParam(params, 'cursor') || undefined, toolSignal,
            ),
          )
        },
      }, options, modelGate, toolGate)
    },
  }
}

async function* runStructuredSpecialist(config: {
  input: AnalyzeFundamentalInput | AnalyzeTechnicalInput
  role: 'fundamental' | 'technical'
  validationRole: 'fundamental_valuation' | 'technical'
  initialTools: Tool[]
  executeDomainTool: (
    name: string, params: unknown, symbol: string,
    runTool: (task: (signal: AbortSignal) => Promise<unknown>) => Promise<ExecutedTool>,
  ) => Promise<ExecutedTool> | undefined
}, options: ModelOptions,
  modelGate: ReturnType<typeof createConcurrencyGate>,
  toolGate: ReturnType<typeof createConcurrencyGate>,
): AsyncGenerator<ModelEvent> {
  const { input } = config
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
  const consumer = new AbortController()
  const agentSignal = AbortSignal.any([executionSignal, consumer.signal])
  const provider = createProviderRuntime(options)
  const queue = createAsyncQueue<ModelEvent>()
  const knownFacts = new Map(input.knownFacts.map((fact) => [fact.id, fact]))
  const validationState = { failures: 0, exhausted: false }
  let policyFailure: Error | undefined
  queue.push(trace({
    type: 'system_prompt', content: input.systemPrompt,
    operationId: `execution:${input.executionId}:system-prompt`,
  }))
  queue.push(trace({
    type: 'user_input', content: input.researchQuestion,
    operationId: `execution:${input.executionId}:research-question`,
  }))
  const runTool = async (
    name: string, onStart: () => Promise<void>, signal: AbortSignal,
    task: (toolSignal: AbortSignal) => Promise<unknown>,
  ) => {
    const owner = await acquireActiveSlot({
      acquire: () => input.acquireToolSlot ? input.acquireToolSlot(signal) : toolGate.acquire(signal),
      activeBudget, signal,
    })
    try {
      await onStart()
      const signal = toolSignal(options, settings, owner.signal)
      const result = await raceWithAbort(() => task(signal), signal)
      const facts = asRecord(result).facts
      if (Array.isArray(facts)) for (const fact of facts as Fact[]) knownFacts.set(fact.id, fact)
      return succeeded(result)
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    } finally { owner.finish() }
  }
  const specialist = runProjectedAgent({
    role: config.role, input, options, settings, executionSignal: agentSignal, activeBudget,
    onPolicyFailure: (error) => { policyFailure ??= error }, modelGate, toolGate,
    provider, queue, initialTools: config.initialTools,
    systemPrompt: input.systemPrompt, userPrompt: specialistUserPrompt(input),
    shouldRejectNextTurn: () => validationState.exhausted,
    execute: async (name, params, signal, onStart) => {
      if (name === unavailableToolName) { await onStart(); return failed('tool_not_available') }
      const symbol = stringParam(params, 'symbol') || input.symbol
      if (symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
        await onStart(); return failed('tool_symbol_not_allowed')
      }
      if (name === 'submit_specialist_report') {
        await onStart()
        const validation = validateReportCandidate(params, {
          role: config.validationRole, knownFacts: [...knownFacts.values()],
        })
        if (!validation.ok) {
          validationState.failures += 1
          if (validationState.failures >= 3) validationState.exhausted = true
          return failedReportValidation(validation.errors, params)
        }
        return {
          ...succeeded({ submitted: true }), report: legacyReport(validation.report),
          reportVersion: { kind: 'specialist', report: validation.report }, terminate: true,
        }
      }
      const domainResult = config.executeDomainTool(
        name, params, symbol, (task) => runTool(name, onStart, signal, task),
      )
      if (domainResult) return domainResult
      return failed('tool_not_available')
    },
  })
  const task = specialist.then((outcome) => {
    if (policyFailure) throw policyFailure
    if (!outcome.report || !outcome.reportVersion) throw new Error('specialist_report_required')
    queue.push({
      type: 'completed', report: outcome.report, reportVersion: outcome.reportVersion,
      usage: outcome.usage, stopReason: outcome.stopReason,
      operationId: `execution:${input.executionId}:report`,
    })
  }).then(() => queue.end(), (error) => queue.fail(error))
  try {
    for await (const event of queue) yield event
    await task
  } finally {
    consumer.abort(new Error('model_consumer_closed'))
    queue.end()
    await task.catch(() => undefined)
  }
}

async function runProjectedAgent(config: {
  role: Role; input: AnalyzeInput | AnalyzeNewsInput | AnalyzeFundamentalInput | AnalyzeTechnicalInput
  options: ModelOptions; settings: RuntimeSettings
  executionSignal: AbortSignal; activeBudget: ActiveBudget
  modelGate: ReturnType<typeof createConcurrencyGate>; toolGate: ReturnType<typeof createConcurrencyGate>
  provider: ReturnType<typeof createProviderRuntime>; queue: ReturnType<typeof createAsyncQueue<ModelEvent>>
  initialTools: Tool[]; systemPrompt: string; userPrompt: string
  initialStage?: Stage
  invocationId?: string
  shouldRejectNextTurn?: () => boolean
  nextResearchTools?: () => Tool[]
  nextFinalizationTools?: () => Tool[]
  beforeNextProjection?: () => Extract<ModelEvent, { type: 'trace' }>['entry'] | undefined
  prepareSpecialistBatch?: (calls: Batch['calls'], batchId: string) => Promise<string[]>
  execute: (
    name: string, params: unknown, signal: AbortSignal, onStart: () => Promise<void>,
  ) => Promise<ExecutedTool>
  onPolicyFailure: (error: Error) => void
}) {
  const { input } = config
  let stage: Stage = config.initialStage ?? 'research'
  let turnIndex = 0
  let toolRounds = 0
  let finalizationAttempts = 0
  let completionOrder = 0
  let activeProjection = await input.toolRuntime!.ensureProjection({
    executionId: input.executionId, role: config.role, stage,
    tools: config.initialTools, createdAt: new Date().toISOString(),
  })
  let currentBatch: Batch | undefined
  let batchCompletion: Promise<void> | undefined
  let completedReport: AnalysisReport | undefined
  let completedReportVersion: ExecutedTool['reportVersion']
  let finalText = ''
  let finalUsage: unknown
  let finalStopReason: string | undefined
  let requestPolicyFailure: Error | undefined
  let toolAuditFailure: Error | undefined
  let lastAssistantHadCalls = false
  let modelEventIndex = 0
  let textDeltaIndex = 0
  let activeModelRequestId: string | undefined
  let compactionIndex = 0
  let compactionDisabled = false
  let compactionAttempt: 1 | 2 = 1
  let activeCompactionRequestId: string | undefined
  let compactionAttemptResults: Array<{ attempt: number; durationMs: number; usage: unknown }> = []
  let pendingCompaction: {
    id: string
    segmentId: string
    operationId: string
    event: Record<string, unknown>
    summary: Record<string, unknown>
    usage: Record<string, unknown>
    createdAt: string
  } | undefined
  let compactionMetrics = {
    contextTokens: 0, contextWindow: config.provider.model.contextWindow,
    reserveTokens: config.settings.compactionReserveTokens, keepRecentTokens: 20_000,
  }
  let visibleTools = [...config.initialTools]
  const completeActiveModelRequest = async (
    status: 'completed' | 'failed' | 'cancelled', usage: unknown,
  ) => {
    const requestId = activeModelRequestId
    if (!requestId) return
    if (!input.toolRuntime?.completeModelRequest) {
      throw new Error('model_request_completion_required')
    }
    const normalizedUsage = modelUsage(usage)
    try {
      await input.toolRuntime.completeModelRequest({
        requestId, executionId: input.executionId, status,
        usageStatus: normalizedUsage.status, usage: normalizedUsage.usage,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      if (!(config.executionSignal.aborted && error instanceof Error
        && error.message === 'agent_execution_fenced')) throw error
    }
    activeModelRequestId = undefined
  }
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
        if (isReportSubmit(definition.name)) throw new Error('report_schema_validated_by_runtime')
        validatedParams = validateToolCall([definition], {
          type: 'toolCall', id: callId, name: definition.name,
          arguments: params as Record<string, unknown>,
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'report_schema_validated_by_runtime') {
          validatedParams = params
        } else { await start(); executed = failed('invalid_tool_arguments') }
      }
      if (executed!) { /* validation failure is already normalized */ }
      else if (completedReport) executed = {
        ...failed('cancelled_after_report_submission'), terminate: true,
      }
      else if (stage === 'finalization' && config.role === 'main'
        && definition.name !== 'submit_analysis_report') executed = failed('tool_not_available')
      else if (stage === 'finalization' && config.role !== 'main'
        && definition.name !== 'submit_specialist_report') executed = failed('tool_not_available')
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
        result: retainedToolResult(executed.result), isError: status !== 'completed',
        operationId: toolOperationId(config.role, input.executionId, callId, 'result'),
      }
      currentBatch?.results.set(callId, audit)
      if (executed.report) completedReport = executed.report
      if (executed.reportVersion) completedReportVersion = executed.reportVersion
      return {
        content: [{
          type: 'text', text: JSON.stringify(modelToolResult(definition.name, executed.result)),
        }],
        details: { audit }, terminate: executed.terminate,
      }
    }, config.role === 'main'
      && !['run_news_analysis', 'run_fundamental_analysis', 'run_technical_analysis']
        .includes(definition.name) ? 'sequential' : undefined)),
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

  const prepareProjection = async (
    tools: Tool[], causativeEvent?: Extract<ModelEvent, { type: 'trace' }>['entry'],
  ) => {
    visibleTools = [...tools]
    activeProjection = await input.toolRuntime!.ensureProjection({
      executionId: input.executionId, role: config.role, stage,
      tools: visibleTools, createdAt: new Date().toISOString(),
      ...(causativeEvent ? { causativeEvent: {
        operationId: causativeEvent.operationId!, payload: causativeEvent as Record<string, unknown>,
      } } : {}),
    })
    return projectedTools()
  }

  const completeCurrentBatch = async (advance?: {
    tools: Tool[]; causativeEvent?: Extract<ModelEvent, { type: 'trace' }>['entry']
  }) => {
    if (batchCompletion) return batchCompletion
    if (!currentBatch) return
    const batch = currentBatch
    const completion = (async () => {
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
      const completed = await input.toolRuntime!.completeToolBatch({
        id: batch.id, executionId: input.executionId,
        results: [...batch.results.values()], completedAt: new Date().toISOString(),
        ...(advance ? { advance: {
          role: config.role, stage, tools: advance.tools, toolRounds,
          activeElapsedMs: config.activeBudget.elapsedMs(),
          ...(advance.causativeEvent ? { causativeEvent: {
            operationId: advance.causativeEvent.operationId!,
            payload: advance.causativeEvent as Record<string, unknown>,
          } } : {}),
        } } : {}),
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
      if (advance) {
        if (!completed.projection) throw new Error('tool_projection_commit_required')
        visibleTools = [...advance.tools]
        activeProjection = completed.projection
      }
      if (currentBatch === batch) currentBatch = undefined
    })()
    batchCompletion = completion
    try { await completion } finally {
      if (batchCompletion === completion) batchCompletion = undefined
    }
  }

  adapter = createPiAgentAdapter({
    initialState: {
      systemPrompt: config.systemPrompt, model: config.provider.model,
      tools: projectedTools(),
    },
    signal: config.executionSignal,
    streamFn: async (model, context, streamOptions) => {
      const request = await beginBudgetedModelRequest(config, config.role !== 'main')
      try {
        turnIndex += 1
        const roleScope = config.invocationId
          ? `${config.role}:invocation:${encodeURIComponent(config.invocationId)}` : config.role
        const requestId = `execution:${input.executionId}:${roleScope}:model-attempt:${turnIndex}`
        await input.toolRuntime!.recordModelRequest({
          requestId, executionId: input.executionId, projectionId: activeProjection.id,
          turnIndex, createdAt: new Date().toISOString(),
        })
        activeModelRequestId = requestId
        config.queue.push(trace({
          type: 'tool_projection', projectionId: activeProjection.id, version: activeProjection.version,
          visibleToolNames: visibleTools.map(({ name }) => name),
          operationId: `${requestId}:tool-projection`,
        }))
        config.queue.push({
          type: 'lifecycle', status: stage === 'finalization' ? 'finalizing' : 'running_model',
          operationId: `${requestId}:running-model`,
        })
        const stream = await raceWithAbort(() => Promise.resolve(config.provider.streamFn(model, {
          ...context, tools: visibleTools.map((tool) => ({ ...tool, label: tool.name } as PiAgentAdapterTool)),
        }, { ...streamOptions, signal: request.signal })), request.signal)
        return finishableStream(stream, request.signal, request.finish, (error) => {
          const normalized = request.normalizeError(error)
          if (normalized instanceof Error && isPolicyFailure(normalized)) {
            requestPolicyFailure ??= normalized
            config.onPolicyFailure(normalized)
          }
          return normalized
        }, async (error) => {
          const usage = error instanceof CompactionGenerationError ? error.usage : null
          await completeActiveModelRequest(
            config.executionSignal.aborted ? 'cancelled' : 'failed', usage,
          )
        })
      } catch (error) {
        request.finish()
        await completeActiveModelRequest(
          config.executionSignal.aborted ? 'cancelled' : 'failed', null,
        )
        throw error
      }
    },
    afterToolCall: async ({ result, isError }) => ({
      isError: Boolean((result.details as { audit?: ToolAudit } | undefined)?.audit?.isError ?? isError),
    }),
    shouldStopAfterTurn: async () => Boolean(completedReport),
    prepareNextTurn: async () => {
      if (completedReport || finalText) return undefined
      const hasToolBatch = Boolean(currentBatch)
      if (config.shouldRejectNextTurn?.()) {
        await completeCurrentBatch()
        throw new Error('report_validation_repair_exhausted')
      }
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
        if (finalizationAttempts > 2) {
          await completeCurrentBatch()
          throw new Error(
            config.role === 'main' ? 'report_tool_required' : 'specialist_finalization_required',
          )
        }
      }
      const causativeEvent = config.beforeNextProjection?.()
      const next = config.role === 'main'
        ? stage === 'finalization'
          ? config.nextFinalizationTools?.() ?? finalizationModelTools
          : config.nextResearchTools?.() ?? analysisModelTools
        : stage === 'finalization'
          ? toolRegistry.project({ role: config.role, stage: 'finalization' })
          : config.role === 'news'
            ? config.nextResearchTools?.() ?? newsSpecialistTools
            : config.role === 'technical' ? technicalSpecialistTools : financialSpecialistTools
      if (hasToolBatch) await completeCurrentBatch({ tools: next, causativeEvent })
      else {
        const turnAdvance = {
          type: 'runtime_turn_advanced', toolRounds,
          activeElapsedMs: config.activeBudget.elapsedMs(), stage,
          operationId: `execution:${input.executionId}:${config.role}:model-attempt:${turnIndex}:turn-advanced`,
        } as Extract<ModelEvent, { type: 'trace' }>['entry']
        await prepareProjection(next, turnAdvance)
      }
      return { tools: projectedTools() }
    },
    commitToolProjection: async ({ tools }) => ({ tools }),
    compaction: {
      settings: {
        enabled: true, reserveTokens: config.settings.compactionReserveTokens,
        keepRecentTokens: 20_000,
      },
      allowed: () => !compactionDisabled && !completedReport && !finalText,
      onContextUsage: async (metrics) => {
        const usageEvent = {
          type: 'context_usage', ...metrics,
          operationId: `execution:${input.executionId}:${config.role}:turn:${turnIndex}:context-usage`,
        } as Extract<ModelEvent, { type: 'trace' }>['entry']
        await prepareProjection(visibleTools, usageEvent)
        config.queue.push(trace(usageEvent))
      },
      shouldRetry: (error) => error instanceof CompactionGenerationError,
      onAttempt: (metrics) => {
        if (metrics.attempt === 1) {
          compactionIndex += 1
          compactionAttemptResults = []
        }
        compactionAttempt = metrics.attempt
        compactionMetrics = metrics
      },
      onAttemptFailure: async ({ attempt, durationMs, error }) => {
        const result = {
          attempt, durationMs,
          usage: error instanceof CompactionGenerationError ? error.usage : null,
        }
        compactionAttemptResults.push(result)
        const requestId = activeCompactionRequestId
        if (requestId) {
          if (!input.toolRuntime?.completeModelRequest) {
            throw new Error('model_request_completion_required')
          }
          const normalizedUsage = modelUsage(
            error instanceof CompactionGenerationError ? error.usage : null,
          )
          try {
            await input.toolRuntime.completeModelRequest({
              requestId, executionId: input.executionId,
              status: config.executionSignal.aborted ? 'cancelled' : 'failed',
              usageStatus: normalizedUsage.status, usage: normalizedUsage.usage,
              completedAt: new Date().toISOString(),
            })
          } catch (auditError) {
            if (!(config.executionSignal.aborted && auditError instanceof Error
              && auditError.message === 'agent_execution_fenced')) throw auditError
          }
          activeCompactionRequestId = undefined
        }
        if (!input.toolRuntime?.recordCompactionAttempt) {
          throw new Error('compaction_attempt_commit_required')
        }
        try {
          await input.toolRuntime.recordCompactionAttempt({
            id: `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}`,
            executionId: input.executionId, ...result,
            status: config.executionSignal.aborted ? 'cancelled' : 'failed',
            createdAt: new Date().toISOString(),
          })
        } catch (auditError) {
          if (!(config.executionSignal.aborted && auditError instanceof Error
            && auditError.message === 'agent_execution_fenced')) throw auditError
        }
      },
      onFatalFailure: async () => {
        if (!input.toolRuntime?.failCompaction) throw new Error('compaction_failure_commit_required')
        const operationId = `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}:fatal`
        const event = {
          type: 'compaction', status: 'failed', attempts: compactionAttemptResults.length,
          contextTokens: compactionMetrics.contextTokens,
          contextWindow: compactionMetrics.contextWindow,
          reserveTokens: compactionMetrics.reserveTokens,
          keepRecentTokens: compactionMetrics.keepRecentTokens,
          attemptResults: compactionAttemptResults, operationId,
        }
        await input.toolRuntime.failCompaction({
          id: `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}`,
          executionId: input.executionId, operationId, event,
          attempts: compactionAttemptResults.map((attempt) => ({
            ...attempt, status: 'failed' as const,
          })), createdAt: new Date().toISOString(),
        })
        config.queue.push(trace(event as Extract<ModelEvent, { type: 'trace' }>['entry']))
      },
      compact: async (cut, signal) => {
        if (!input.toolRuntime?.commitCompaction) throw new Error('compaction_commit_required')
        const startedAt = new Date().toISOString()
        const requestId = `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}:attempt:${compactionAttempt}`
        await input.toolRuntime.recordModelRequest({
          requestId, executionId: input.executionId, projectionId: activeProjection.id,
          turnIndex: Math.max(1, turnIndex), kind: 'compaction', createdAt: startedAt,
        })
        activeCompactionRequestId = requestId
        const request = await beginBudgetedModelRequest(config, config.role !== 'main')
        let compacted: { narrative: string; usage: Record<string, unknown> }
        try {
          compacted = config.options.compact
            ? await config.options.compact({ ...cut, signal: request.signal })
            : await compactWithProvider(config.provider, cut, request.signal)
        } catch (error) {
          const normalized = request.normalizeError(error)
          if (request.signal.aborted || isPolicyFailure(normalized)) throw normalized
          throw normalized instanceof CompactionGenerationError
            ? normalized : new CompactionGenerationError(normalized)
        } finally { request.finish() }
        if (!input.toolRuntime.completeModelRequest) {
          throw new Error('model_request_completion_required')
        }
        const normalizedUsage = modelUsage(compacted.usage)
        await input.toolRuntime.completeModelRequest({
          requestId, executionId: input.executionId, status: 'completed',
          usageStatus: normalizedUsage.status, usage: normalizedUsage.usage,
          completedAt: new Date().toISOString(),
        })
        activeCompactionRequestId = undefined
        const summary = compactionSummaryContract(
          config.role, config.userPrompt, input,
          [...cut.messagesToSummarize, ...cut.turnPrefixMessages, ...cut.retainedTail],
          compacted.narrative,
        )
        const segmentId = randomUUID()
        const completedAt = new Date().toISOString()
        const operationId = `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}:completed`
        const compactionId = `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}`
        const event = {
          type: 'compaction', status: 'completed', attempt: compactionAttempt,
          toSegmentId: segmentId, contextTokens: compactionMetrics.contextTokens,
          contextWindow: compactionMetrics.contextWindow,
          reserveTokens: compactionMetrics.reserveTokens,
          keepRecentTokens: compactionMetrics.keepRecentTokens, usage: compacted.usage,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          attemptResults: compactionAttemptResults,
        }
        pendingCompaction = {
          id: compactionId, segmentId, operationId, event, summary,
          usage: compacted.usage, createdAt: completedAt,
        }
        return [userMessage(
          `【系统生成的 Compaction Summary，不是报告证据】\n${JSON.stringify(summary)}`,
        ), ...cut.retainedTail]
      },
      commit: async ({ tokensAfter }) => {
        if (!pendingCompaction || !input.toolRuntime?.commitCompaction) {
          throw new Error('compaction_commit_state_missing')
        }
        const pending = pendingCompaction
        const persistedEvent = { ...pending.event, tokensAfter, estimated: true }
        await input.toolRuntime.commitCompaction({
          id: pending.id, executionId: input.executionId, segmentId: pending.segmentId,
          operationId: pending.operationId, event: persistedEvent,
          contextTokens: compactionMetrics.contextTokens,
          contextWindow: compactionMetrics.contextWindow,
          reserveTokens: compactionMetrics.reserveTokens,
          keepRecentTokens: compactionMetrics.keepRecentTokens,
          tokensAfter,
          summary: pending.summary, usage: pending.usage, createdAt: pending.createdAt,
          attempts: [
            ...compactionAttemptResults.map((attempt) => ({
              ...attempt, status: 'failed' as const,
            })),
            {
              attempt: compactionAttempt, status: 'completed' as const,
              durationMs: pending.event.durationMs as number, usage: pending.usage,
            },
          ],
        })
        config.queue.push(trace({
          type: 'compaction', status: 'completed', segmentId: pending.segmentId,
          contextTokens: compactionMetrics.contextTokens,
          contextWindow: compactionMetrics.contextWindow,
          reserveTokens: compactionMetrics.reserveTokens,
          keepRecentTokens: compactionMetrics.keepRecentTokens,
          tokensAfter,
          usage: pending.usage,
          durationMs: pending.event.durationMs as number,
          attemptResults: compactionAttemptResults,
          operationId: pending.operationId,
        }))
        pendingCompaction = undefined
      },
      onFailure: async () => {
        compactionDisabled = true
        const failed = {
          type: 'compaction', status: 'failed', attempts: 2,
          contextTokens: compactionMetrics.contextTokens,
          contextWindow: compactionMetrics.contextWindow,
          reserveTokens: compactionMetrics.reserveTokens,
          keepRecentTokens: compactionMetrics.keepRecentTokens,
          attemptResults: compactionAttemptResults,
          operationId: `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}:failed`,
        } as Extract<ModelEvent, { type: 'trace' }>['entry']
        const createdAt = new Date().toISOString()
        if (compactionMetrics.contextTokens >= compactionMetrics.contextWindow) {
          if (!input.toolRuntime?.failCompaction) throw new Error('compaction_failure_commit_required')
          await input.toolRuntime.failCompaction({
            id: `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}`,
            executionId: input.executionId, operationId: failed.operationId!,
            event: failed as Record<string, unknown>,
            attempts: compactionAttemptResults.map((attempt) => ({
              ...attempt, status: 'failed' as const,
            })), createdAt,
          })
          config.queue.push(trace(failed))
          throw new Error('compaction_capacity_exhausted')
        }
        stage = 'finalization'
        if (!input.toolRuntime?.failCompaction) throw new Error('compaction_failure_commit_required')
        await input.toolRuntime.failCompaction({
          id: `execution:${input.executionId}:${config.role}:compaction:${compactionIndex}`,
          executionId: input.executionId, operationId: failed.operationId!,
          event: failed as Record<string, unknown>,
          attempts: compactionAttemptResults.map((attempt) => ({
            ...attempt, status: 'failed' as const,
          })), createdAt,
        })
        const tools = config.role === 'main'
          ? config.nextFinalizationTools?.() ?? finalizationModelTools
          : toolRegistry.project({ role: config.role, stage: 'finalization' })
        await prepareProjection(tools, failed)
        config.queue.push(trace(failed))
        return { tools: projectedTools() }
      },
    },
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
      const requestStatus = event.message.stopReason === 'aborted'
        ? 'cancelled' : event.message.stopReason === 'error' ? 'failed' : 'completed'
      await completeActiveModelRequest(requestStatus, event.message.usage)
      finalUsage = event.message.usage
      finalStopReason = event.message.stopReason
      const calls = event.message.content.filter((content) => content.type === 'toolCall')
      lastAssistantHadCalls = calls.length > 0
      if (!calls.length) {
        if ('runtimeFollowUp' in input && input.runtimeFollowUp
          && input.runtimeFollowUp.content.updateReport !== true) {
          finalText = event.message.content.flatMap((content) => (
            content.type === 'text' ? [content.text] : []
          )).join('')
          return
        }
        const submitTool = config.role === 'main'
          ? 'submit_analysis_report' : 'submit_specialist_report'
        adapter.followUp(userMessage(stage === 'finalization'
          ? `请立即调用 ${submitTool} 提交受限报告。`
          : `请继续自主规划，准备好后调用 ${submitTool}。`))
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
          : config.role === 'news'
            ? `${providerId}:news-attempt:${turnIndex}:position:${index + 1}`
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
      const specialistSessionIds = await config.prepareSpecialistBatch?.(batch.calls, batch.id) ?? []
      config.queue.push(specialistSessionIds.length ? {
        type: 'lifecycle', status: 'waiting_for_specialists',
        waitTarget: `专项 Session：${specialistSessionIds.join('、')}`,
        operationId: `${batch.id}:waiting-for-specialists`,
      } : {
        type: 'lifecycle', status: 'running_tools', operationId: `${batch.id}:running-tools`,
      })
    }
    if (event.type === 'tool_execution_end' && currentBatch
      && !currentBatch.results.has(event.toolCallId)) {
      const now = new Date().toISOString()
      const result = retainedToolResult(adapterToolResult(event.result))
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
    if (event.type === 'turn_end' && currentBatch && toolAuditFailure) throw toolAuditFailure
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
  await completeCurrentBatch()
  const snapshot = adapter.snapshot()
  adapter.dispose()
  if (requestPolicyFailure) throw requestPolicyFailure
  if (toolAuditFailure) throw toolAuditFailure
  if (snapshot.errorMessage) throw new Error(snapshot.errorMessage)
  const facts = snapshot.messages.filter((message) => message.role === 'toolResult')
    .flatMap((message) => parseFacts(message))
  return {
    report: completedReport, reportVersion: completedReportVersion, text: finalText, facts,
    usage: finalUsage, stopReason: finalStopReason,
  }
}

type ExecutedTool = {
  result: Record<string, unknown>; isError: boolean; terminate?: boolean; report?: AnalysisReport
  reportVersion?: { kind: 'integrated' | 'specialist'; report: Record<string, unknown> }
  completedAt?: string
}

function createProviderRuntime(options: ModelOptions) {
  if (options.contextWindow !== undefined
    && (!Number.isInteger(options.contextWindow) || options.contextWindow <= 0)) {
    throw new Error('model_context_window_invalid')
  }
  const models = (options.modelsFactory ?? createModels)()
  let model: Model<Api>
  if (options.fauxResponses) {
    const faux = fauxProvider({ tokensPerSecond: options.fauxTokensPerSecond ?? 1000 })
    models.setProvider(faux.provider)
    faux.setResponses(options.fauxResponses as FauxResponseStep[])
    model = faux.getModel()
  } else if (options.provider && options.apiProtocol && options.modelName && options.baseUrl && options.apiKey) {
    const api = options.apiProtocol === 'responses' ? 'openai-responses' : 'openai-completions'
    const catalogModel = models.getModel(options.provider, options.modelName)
    const contextWindow = options.contextWindow ?? catalogModel?.contextWindow
    if (contextWindow === undefined) {
      throw new Error('model_context_window_required')
    }
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error('model_context_window_invalid')
    }
    const configured: Model<Api> = {
      id: options.modelName, name: options.modelName, api, provider: options.provider,
      baseUrl: options.baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow, maxTokens: Math.min(16_000, contextWindow),
    }
    models.setProvider(createProvider({
      id: options.provider, name: options.provider, baseUrl: options.baseUrl,
      auth: { apiKey: { name: 'provider API key', resolve: async () => ({ auth: { apiKey: options.apiKey } }) } },
      models: [configured],
      api: api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
    }))
    model = catalogModel ? { ...catalogModel, contextWindow } : configured
  } else throw new Error('model_not_configured')
  if (options.contextWindow !== undefined) model = { ...model, contextWindow: options.contextWindow }
  const streamFn: PiAgentAdapterStreamFn = (selected, context, streamOptions) => models.stream(
    selected as Model<Api>, context as never,
    { signal: streamOptions?.signal, apiKey: options.apiKey },
  ) as unknown as PiAgentAdapterStream
  return { model, streamFn }
}

async function compactWithProvider(
  provider: ReturnType<typeof createProviderRuntime>,
  cut: {
    messagesToSummarize: PiAgentAdapterMessage[]
    turnPrefixMessages: PiAgentAdapterMessage[]
    retainedTail: PiAgentAdapterMessage[]
    isSplitTurn: boolean
  },
  signal: AbortSignal,
) {
  const stream = await Promise.resolve(provider.streamFn(provider.model, {
    systemPrompt: [
      '你是研究上下文压缩器。只总结给定消息中的目标、已作决定和未决问题。',
      '不得生成新事实、投资结论或报告证据；不得省略事实 ID、报告版本和专项状态。',
      '输出简洁中文纯文本，不调用工具。',
    ].join('\n'),
    messages: [userMessage(JSON.stringify({
      messagesToSummarize: cut.messagesToSummarize,
      turnPrefixMessages: cut.turnPrefixMessages,
      isSplitTurn: cut.isSplitTurn,
    }))],
    tools: [],
  }, { signal }))
  const finishable = finishableStream(stream, signal, () => {}, (error) => error)
  for await (const _event of finishable) { /* consume the complete provider stream */ }
  const message = await finishable.result()
  const usage = message.role === 'assistant' ? message.usage : null
  if (message.role !== 'assistant' || message.stopReason === 'error'
    || message.content.some((item) => item.type === 'toolCall')) {
    throw new CompactionGenerationError(
      new Error('compaction_summary_invalid'), usage,
    )
  }
  const narrative = contentText(message.content).trim()
  if (!narrative) throw new CompactionGenerationError(
    new Error('compaction_summary_empty'), message.usage,
  )
  return { narrative, usage: message.usage as unknown as Record<string, unknown> }
}

function compactionSummaryContract(
  role: Role,
  goal: string,
  input: AnalyzeInput | AnalyzeNewsInput | AnalyzeFundamentalInput | AnalyzeTechnicalInput,
  messages: PiAgentAdapterMessage[],
  narrative: string,
) {
  const facts = new Set<string>()
  for (const fact of input.knownFacts) facts.add(fact.id)
  const reportVersions: Array<Record<string, unknown>> = []
  const specialistStatuses: Array<Record<string, unknown>> = []
  const unresolved: string[] = []
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    const result = parseToolResultRecord(message)
    for (const fact of Array.isArray(result.facts) ? result.facts : []) {
      if (fact && typeof fact === 'object' && typeof (fact as { id?: unknown }).id === 'string') {
        facts.add((fact as { id: string }).id)
      }
    }
    if (typeof result.reportId === 'string' && typeof result.reportVersion === 'number') {
      reportVersions.push({
        reportId: result.reportId, version: result.reportVersion,
        sessionId: result.sessionId, status: result.status,
      })
    }
    if (typeof result.status === 'string' && typeof result.sessionId === 'string') {
      specialistStatuses.push({
        sessionId: result.sessionId, status: result.status, executionId: result.executionId,
      })
    }
    if (typeof result.error === 'string') unresolved.push(result.error)
    for (const gap of Array.isArray(result.gaps) ? result.gaps : []) {
      if (gap && typeof gap === 'object') unresolved.push(JSON.stringify(gap))
    }
  }
  return {
    schemaVersion: 1, isReportEvidence: false, role, goal,
    decisions: specialistStatuses.map((status) => ({
      sessionId: status.sessionId, status: status.status,
    })),
    reportVersions, specialistStatuses,
    factIds: [...facts], unresolved: [...new Set(unresolved)],
    personalContext: 'runtimeContext' in input ? input.runtimeContext?.content.personalContext ?? null : null,
    narrative,
  }
}

function parseToolResultRecord(message: Extract<PiAgentAdapterMessage, { role: 'toolResult' }>) {
  const text = contentText(message.content)
  try { return asRecord(JSON.parse(text)) } catch { return {} }
}

async function beginBudgetedModelRequest(config: {
  input: AnalyzeInput | AnalyzeNewsInput | AnalyzeFundamentalInput | AnalyzeTechnicalInput
  options: ModelOptions; settings: RuntimeSettings
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
  onFailure: (error: unknown) => Promise<void> = async () => {},
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
      return {
        async next() {
          try {
            iterator ??= stream[Symbol.asyncIterator]()
            const item = await nextOrAbort(iterator!, signal, closeIterator)
            if (item.done) finish()
            return item as never
          }
          catch (error) {
            try {
              await closeIterator()
            } finally {
              finish()
              await onFailure(error)
            }
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
      } catch (error) {
        await onFailure(error)
        throw normalizeError(error)
      } finally { finish() }
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

function modelUsage(value: unknown) {
  const token = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && input >= 0
    ? input : null
  const raw = value !== null && typeof value === 'object'
    ? value as Record<string, unknown> : {}
  const usage = {
    input: token(raw.input), cacheRead: token(raw.cacheRead),
    cacheWrite: token(raw.cacheWrite), output: token(raw.output),
    total: token(raw.totalTokens),
  }
  const reported = Object.values(usage).filter((item) => item !== null).length
  const complete = reported === 5 && usage.total === (
    usage.input! + usage.cacheRead! + usage.cacheWrite! + usage.output!
  )
  return {
    usage,
    status: complete ? 'complete' as const
      : reported === 0 ? 'unknown' as const : 'partial' as const,
  }
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
  const namespace = role === 'main' ? 'tool'
    : role === 'fundamental' ? 'specialist-tool' : 'news-tool'
  return `execution:${executionId}:${namespace}:${callId}:${suffix}`
}
function isReportSubmit(name: string) {
  return name === 'submit_analysis_report' || name === 'submit_specialist_report'
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
  return toolRegistry.projectResult(name, result)
}
function retainedToolResult(result: Record<string, unknown>) {
  if (!('modelProjection' in result)) return result
  const { modelProjection: _temporary, ...retained } = result
  return retained
}
function stringParam(value: unknown, key: string) {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof entry === 'string' ? entry : ''
}
function normalizeQuery(value: string) { return value.trim().replace(/\s+/g, ' ').toLowerCase() }
function validWebSearchReasons(reasons: Array<{ source: string; reason: string }>) {
  const allowed = ['unavailable', 'empty', 'irrelevant', 'title_only']
  return reasons.length === 3
    && new Set(reasons.map(({ source }) => source)).size === 3
    && reasons.every(({ source, reason }) => Boolean(source) && allowed.includes(reason))
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
function userMessage(content: string): PiAgentAdapterMessage {
  return { role: 'user', content, timestamp: Date.now() }
}
function runtimeContextMessage(context: NonNullable<AnalyzeInput['runtimeContext']>) {
  return `【系统生成的 Runtime Context，不是用户输入】\n${JSON.stringify(context.content)}`
}
function runtimeResumeMessage(context: NonNullable<AnalyzeInput['runtimeResume']>) {
  return `【系统生成的 Runtime Resume，不是用户输入】\n${JSON.stringify(context.content)}`
}
function runtimeFollowUpMessage(context: NonNullable<AnalyzeInput['runtimeFollowUp']>) {
  return `【系统生成的 Follow-up Runtime Context，不是用户输入】\n${JSON.stringify(context.content)}`
}
function specialistUserPrompt(input: AnalyzeNewsInput | AnalyzeFundamentalInput | AnalyzeTechnicalInput) {
  return [input.researchQuestion, input.runtimeResume
    ? runtimeResumeMessage(input.runtimeResume) : ''].filter(Boolean).join('\n')
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

function legacyReport(report: Record<string, unknown>): AnalysisReport {
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
      return {
        judgment: asString(judgment.statement),
        evidence: asStringArray(judgment.supportingEvidence),
      }
    }) : [],
  }
}
function failedReportValidation(
  errors: import('./report-validation.js').ReportValidationError[], candidate: unknown,
): ExecutedTool {
  return {
    result: {
      error: 'report_validation_failed', errors,
      candidatePayloadHash: reportPayloadHash(candidate), facts: [],
    },
    isError: true,
  }
}
function reportPayloadHash(candidate: unknown) {
  return createHash('sha256').update(JSON.stringify(candidate)).digest('hex')
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
