import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentEvent, AgentEventRepository, AnalysisRepository, RuntimeSettingsRepository,
  ToolProjectionRepository,
} from '@vibe-invest/product-dao'
import {
  agentExecutionStatuses, defaultRuntimeSettings, isTerminalAgentExecutionStatus,
  waitReasonForStatus,
  type AgentExecutionStatus, type RuntimeSettings,
} from '@vibe-invest/contracts'

import type { AnalyzeInput, AnalysisReport, ModelEvent, ToolRuntime } from './model.js'
import type { FactQueryResult, FinancialContext, FinancialFact } from './financial-data-client.js'
import { acquireActiveSlot, createActiveBudget, createConcurrencyGate } from './runtime-policy.js'
import { analysisModelTools } from './tools.js'

type Fact = FinancialFact
type Model = { analyze(input: AnalyzeInput): AsyncIterable<ModelEvent> }

export function createAnalysisService(options: {
  repository: AnalysisRepository
  eventRepository: AgentEventRepository
  settingsRepository: RuntimeSettingsRepository
  toolProjectionRepository: ToolProjectionRepository
  model: Model
  fetchFinancialContext: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  fetchTechnicalIndicators?: (
    symbol: string, startDate: string, endDate: string, signal: AbortSignal,
  ) => Promise<FactQueryResult>
  fetchMarketPrices?: (symbols: string[], signal: AbortSignal) => Promise<Record<string, number>>
  listPortfolioSymbols?: () => Promise<string[]>
  getPortfolioContext?: (symbol: string, marketPrices: Record<string, number>) => Promise<unknown>
  runtimeMinuteMs?: number
  activeNow?: () => number
  activeTimeoutSignal?: (timeoutMs: number) => AbortSignal
  runEnabled?: boolean
}) {
  const { repository } = options
  const controllers = new Map<string, AbortController>()
  const listeners = new Map<string, Set<(entry: AgentEvent) => void>>()
  const tasks = new Set<Promise<void>>()
  const analysisTasks = new Map<string, Promise<void>>()
  const toolGate = createConcurrencyGate()
  const modelGate = createConcurrencyGate()
  let running = 0
  let concurrency: number = defaultRuntimeSettings.analysisConcurrency
  const initialized = Promise.all([
    options.eventRepository.interruptActiveSessions(new Date().toISOString()),
    options.settingsRepository.current().then((revision) => {
      concurrency = revision.values.analysisConcurrency
      modelGate.setLimit(revision.values.modelConcurrency)
      toolGate.setLimit(revision.values.toolConcurrency)
    }),
  ])
  const toolRuntime: ToolRuntime = {
    async ensureProjection(input) {
      const visibleToolNames = input.tools.map(({ name }) => name)
      const schemaHash = createHash('sha256').update(JSON.stringify(input.tools)).digest('hex')
      const projection = await options.toolProjectionRepository.ensureVersion({
        executionId: input.executionId, role: input.role, stage: input.stage,
        schemaHash, projectedTools: input.tools, visibleToolNames,
        reasons: { role: input.role, stage: input.stage },
        createdAt: input.createdAt,
      })
      return { id: projection.id, version: projection.version }
    },
    async recordModelRequest(input) {
      await options.toolProjectionRepository.recordModelRequest({
        id: input.requestId, executionId: input.executionId, projectionId: input.projectionId,
        turnIndex: input.turnIndex, createdAt: input.createdAt,
      })
    },
    async beginModelRequest(input) {
      const projection = await toolRuntime.ensureProjection(input)
      await toolRuntime.recordModelRequest({
        requestId: input.requestId, executionId: input.executionId,
        projectionId: projection.id, turnIndex: input.turnIndex, createdAt: input.createdAt,
      })
      return projection
    },
    async beginToolBatch(input) {
      await options.toolProjectionRepository.beginToolBatch(input)
    },
    async startToolCall(input) {
      const event = await options.toolProjectionRepository.startToolCall(input)
      for (const listener of listeners.get(event.sessionId) ?? []) listener(event)
    },
    async completeToolBatch(input) {
      const events = await options.toolProjectionRepository.completeToolBatch({
        id: input.id, executionId: input.executionId, completedAt: input.completedAt,
        results: input.results.map((result) => ({
          toolCallId: result.toolCallId, status: result.status,
          startedAt: result.startedAt, completedAt: result.completedAt,
          completionOrder: result.completionOrder,
          resultPayload: {
            toolName: result.toolName, result: result.result, isError: result.isError,
          },
          operationId: result.operationId,
          eventPayload: {
            type: 'tool_result', name: result.toolName, toolCallId: result.toolCallId,
            result: result.result,
            isError: result.isError, startedAt: result.startedAt,
            completedAt: result.completedAt, completionOrder: result.completionOrder,
            ...(result.startedAt === null ? { notStarted: true } : {}),
            operationId: result.operationId,
          },
        })),
      })
      for (const event of events) {
        for (const listener of listeners.get(event.sessionId) ?? []) listener(event)
      }
    },
  }

  async function appendEvent(
    sessionId: string,
    executionId: string,
    operationId: string,
    payload: Record<string, unknown>,
    projection?: {
      status?: string; executionStatus?: import('@vibe-invest/contracts').AgentExecutionStatus
      waitTarget?: string; terminal?: boolean
      report?: unknown; snapshot?: unknown; error?: string; facts?: Fact[]
      reportVersion?: {
        id: string; kind: 'integrated' | 'specialist'; payloadHash: string; report: unknown
      }
    },
  ) {
    const createdAt = new Date().toISOString()
    const executionStatus = projection?.executionStatus
    const waitReason = executionStatus
      ? waitReasonForStatus(executionStatus, projection?.waitTarget ?? waitTarget(executionStatus), createdAt)
      : undefined
    const event = waitReason === undefined ? payload : { ...payload, waitReason }
    const result = await options.eventRepository.append({
      sessionId, executionId, operationId, event, projection, createdAt,
    })
    if (result.created) {
      for (const cancelled of result.cancelledToolEvents ?? []) {
        for (const listener of listeners.get(sessionId) ?? []) listener(cancelled)
      }
      for (const listener of listeners.get(sessionId) ?? []) listener(result.event)
    }
    return result.event
  }
  async function appendTrace(sessionId: string, executionId: string, payload: unknown) {
    if (!payload || typeof payload !== 'object') return
    const entry = payload as Record<string, unknown>
    if (entry.type === 'model_event'
      && (entry.event as Record<string, unknown> | undefined)?.type === 'thinking_delta') return
    if (typeof entry.operationId !== 'string') throw new Error('agent_event_operation_id_required')
    const facts = entry.type === 'tool_result'
      ? ((entry.result as { facts?: Fact[] } | undefined)?.facts ?? [])
      : []
    await appendEvent(sessionId, executionId, entry.operationId, entry, facts.length ? { facts } : undefined)
  }
  async function setStatus(
    sessionId: string,
    executionId: string,
    operationId: string,
    status: string,
    extra: {
      report?: unknown; snapshot?: unknown; error?: string; terminal?: boolean
      reportVersion?: {
        id: string; kind: 'integrated' | 'specialist'; payloadHash: string; report: unknown
      }
    } = {},
    waitTargetOverride?: string,
  ) {
    const executionStatus = status
    await appendEvent(sessionId, executionId, operationId, {
      type: 'status', status: executionStatus, at: new Date().toISOString(),
      terminal: extra.terminal ?? isTerminalAgentExecutionStatus(executionStatus, true),
      ...(extra.error ? { error: extra.error } : {}),
    }, {
      status: executionStatus,
      ...(extra.report !== undefined ? { report: extra.report } : {}),
      ...(extra.snapshot !== undefined ? { snapshot: extra.snapshot } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.reportVersion !== undefined ? { reportVersion: extra.reportVersion } : {}),
      ...(isExecutionStatus(executionStatus) ? {
        executionStatus,
        ...(waitTargetOverride ? { waitTarget: waitTargetOverride } : {}),
        terminal: extra.terminal ?? isTerminalAgentExecutionStatus(executionStatus, true),
      } : {}),
    })
  }
  async function get(analysisId: string) {
    await initialized
    return repository.get(analysisId)
  }
  async function create(symbolInput: string) {
    await initialized
    const symbol = symbolInput.trim().toUpperCase()
    const analysisId = randomUUID(), now = new Date().toISOString()
    const sessionId = randomUUID()
    const executionId = randomUUID()
    const result = await options.eventRepository.createResearch({
      analysisId,
      sessionId,
      executionId,
      segmentId: randomUUID(),
      symbol,
      status: 'planning',
      analysisStatus: 'queued',
      operationId: `session:${sessionId}:created`,
      event: {
        type: 'runtime_context', status: 'planning', executionId, generation: 1,
        waitReason: { kind: 'database', target: '首次研究初始化', startedAt: now }, at: now,
      },
      createdAt: now,
    })
    if (!result.created) return {
      analysisId: result.analysisId, sessionId: result.sessionId,
      executionId: (await options.eventRepository.getSession(result.sessionId))!.executionId,
      existing: true,
    }
    if (options.runEnabled !== false) queueMicrotask(() => void schedule())
    return { analysisId: result.analysisId, sessionId: result.sessionId, executionId, existing: false }
  }
  async function schedule() {
    while (running < concurrency) {
      running += 1
      const now = new Date().toISOString()
      let next: string | null
      try {
        next = await repository.claimNextQueued(now)
      } catch {
        running -= 1
        return
      }
      if (!next) { running -= 1; return }
      const session = await options.eventRepository.findPrimarySession(next)
      if (!session) { running -= 1; continue }
      const executionId = session.executionId
      const settingsSnapshot = await options.settingsRepository.getExecutionSnapshot(executionId)
      if (!settingsSnapshot) {
        await setStatus(
          session.id, executionId, `execution:${executionId}:settings-snapshot-missing`, 'interrupted',
          { error: 'execution_settings_snapshot_missing' },
        )
        running -= 1
        continue
      }
      if ((await repository.get(next))?.status !== 'running') {
        running -= 1
        continue
      }
      const wallBudgetMs = settingsSnapshot.values.executionWallClockMinutes
        * (options.runtimeMinuteMs ?? 60_000)
      const remainingWallMs = wallBudgetMs - (Date.now() - Date.parse(session.createdAt))
      if (remainingWallMs <= 0) {
        await setStatus(session.id, executionId, `execution:${executionId}:budget-exhausted`, 'budget_exhausted', {
          error: 'execution_runtime_timeout',
        })
        running -= 1
        continue
      }
      try {
        await appendEvent(
          session.id,
          executionId,
          `execution:${executionId}:running`,
          { type: 'status', status: 'planning', at: now },
          { status: 'running', executionStatus: 'planning', waitTarget: '金融与组合上下文' },
        )
      } catch {
        try {
          await setStatus(
            session.id, executionId, `execution:${executionId}:running-failed`, 'interrupted',
            { error: 'analysis_running_trace_failed' },
          )
        } catch {
          // The claimed task must never proceed when its critical audit write failed.
        }
        running -= 1
        continue
      }
      const task = run(next, session.id, executionId, settingsSnapshot.values, remainingWallMs)
        .finally(() => { analysisTasks.delete(next); running -= 1; void schedule() })
      analysisTasks.set(next, task)
      tasks.add(task)
      void task.then(() => tasks.delete(task), () => tasks.delete(task))
    }
  }
  async function run(
    analysisId: string, sessionId: string, executionId: string,
    runtimeSettings: RuntimeSettings, remainingWallMs: number,
  ) {
    const controller = new AbortController()
    controllers.set(analysisId, controller)
    const job = await get(analysisId)
    if (!job || job.status !== 'running') { controllers.delete(analysisId); return }
    const wallDeadline = AbortSignal.timeout(Math.max(1, Math.ceil(remainingWallMs)))
    const executionSignal = AbortSignal.any([controller.signal, wallDeadline])
    const activeBudget = createActiveBudget(
      runtimeSettings.researchActiveMinutes * (options.runtimeMinuteMs ?? 60_000),
      options.activeNow,
      options.activeTimeoutSignal,
    )
    let processing = activeBudget.start(executionSignal)
    const pauseProcessing = () => processing.stop()
    const resumeProcessing = () => { processing = activeBudget.start(executionSignal) }
    const assertPolicy = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      if (wallDeadline.aborted) throw new Error('execution_runtime_timeout')
    }
    const operationId = (kind: string) => `execution:${executionId}:${kind}`
    let modelEventSequence = 0
    let lifecycleStatus: AgentExecutionStatus = 'planning'
    let context: FinancialContext | undefined
    const nextModelOperationId = (kind: string) => (
      `execution:${executionId}:model:${++modelEventSequence}:${kind}`
    )
    try {
      pauseProcessing()
      const contextOwner = await acquireActiveSlot({
        acquire: () => toolGate.acquire(executionSignal), activeBudget, signal: executionSignal,
      })
      try {
        context = await options.fetchFinancialContext(job.symbol, contextOwner.signal)
      } finally {
        contextOwner.finish()
      }
      resumeProcessing()
      assertPolicy()
      if (!context) throw new Error('financial_context_unavailable')
      const quoteFact = context.facts.find((fact) => fact.type === 'quote' && typeof fact.value === 'number')
      let portfolioPrices: Record<string, number> = {}
      let portfolioPriceGap = false
      if (options.fetchMarketPrices && options.listPortfolioSymbols) {
        try {
          pauseProcessing()
          const pricesOwner = await acquireActiveSlot({
            acquire: () => toolGate.acquire(executionSignal), activeBudget, signal: executionSignal,
          })
          try {
            portfolioPrices = await options.fetchMarketPrices(
              await options.listPortfolioSymbols(), pricesOwner.signal,
            )
          } finally {
            pricesOwner.finish()
          }
          resumeProcessing()
          assertPolicy()
        } catch (error) {
          resumeProcessing()
          if (executionSignal.aborted || activeBudget.exhausted()) throw error
          portfolioPriceGap = true
        }
      }
      if (quoteFact) portfolioPrices[job.symbol] = quoteFact.value as number
      const portfolioContext = await options.getPortfolioContext?.(
        job.symbol,
        portfolioPrices,
      ) ?? { position: null, portfolio: null }
      const gaps = [
        ...(context.gaps ?? []),
        ...(portfolioPriceGap ? [{ capability: 'portfolio_prices', reason: 'source_unavailable' }] : []),
      ]
      const snapshot = { ...context, gaps, portfolioContext, createdAt: new Date().toISOString() }
      await appendEvent(sessionId, executionId, operationId('financial-context'), {
        type: 'financial_context',
        gaps,
        capabilities: sourceDiagnostics(context),
        degradedSources: sourceDegradations(context),
      }, { snapshot, facts: context.facts })
      assertPolicy()
      const modelContext = createModelContext(snapshot)
      const runtimeContext = createInitialRuntimeContext(modelContext, portfolioContext)
      await appendEvent(
        sessionId, executionId, operationId('running-model'),
        { type: 'status', status: 'running_model' },
        { executionStatus: 'running_model' },
      )
      pauseProcessing()
      for await (const event of options.model.analyze({
        executionId,
        runtimeSettings,
        symbol: job.symbol,
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        runtimeContext,
        knownFacts: modelContext.facts,
        fetchFinancialContext: async () => modelContext,
        financialContextToolViews: { model: modelContext, retained: snapshot },
        signal: controller.signal,
        executionDeadlineSignal: wallDeadline,
        activeBudget,
        acquireModelSlot: (signal) => modelGate.acquire(signal),
        acquireToolSlot: (signal) => toolGate.acquire(signal),
        searchNews: options.searchNews,
        fetchTechnicalIndicators: options.fetchTechnicalIndicators,
        toolRuntime,
      })) {
        resumeProcessing()
        assertPolicy()
        if (event.type === 'lifecycle') {
          await setStatus(sessionId, executionId, event.operationId, event.status, {
            terminal: event.status === 'budget_exhausted' ? false : undefined,
          }, event.waitTarget)
          lifecycleStatus = event.status
        }
        else if (event.type === 'trace') {
          if (event.entry.type === 'tool_result' && typeof event.entry.operationId === 'string') continue
          await appendTrace(sessionId, executionId, event.entry.operationId ? event.entry : {
            ...event.entry, operationId: nextModelOperationId(event.entry.type),
          })
        }
        else if (event.type === 'text_delta') await appendTrace(sessionId, executionId, event.operationId ? event : {
          ...event, operationId: nextModelOperationId('text-delta'),
        })
        else if (event.type === 'cancelled') {
          await setStatus(
            sessionId, executionId, event.operationId ?? nextModelOperationId('stopped'), 'stopped',
          ); return
        }
        else if (event.type === 'completed') {
          if (lifecycleStatus !== 'finalizing') await setStatus(
            sessionId, executionId, event.operationId
              ? `${event.operationId}:finalizing`
              : nextModelOperationId('finalizing'), 'finalizing',
          )
          await appendTrace(sessionId, executionId, {
            operationId: event.operationId ?? nextModelOperationId('completed'),
            type: 'model_completed',
            usage: event.usage ?? null,
            stopReason: event.stopReason ?? null,
          })
          const hasPosition = Boolean((portfolioContext as { position?: unknown }).position)
          const personalized = hasPosition ? event.report : {
            ...event.report,
            personalImpact: null,
            conditionalSuggestion: null,
          }
          const report = enforceDataGaps(personalized, gaps)
          const status = report.limitations.length ? 'partial' : 'completed'
          const reportVersion = event.reportVersion
            ? finalReportVersion(executionId, event.reportVersion, report, status, gaps) : undefined
          await setStatus(sessionId, executionId, operationId(`status-${status}`), status, {
            report, ...(reportVersion ? { reportVersion } : {}),
          })
          return
        }
        assertPolicy()
        pauseProcessing()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return
      } else if (wallDeadline.aborted) {
        await setStatus(sessionId, executionId, operationId('budget-exhausted'), 'budget_exhausted', {
          error: 'execution_runtime_timeout',
        })
      } else if (activeBudget.exhausted()) {
        await setStatus(sessionId, executionId, operationId('budget-exhausted'), 'budget_exhausted', { terminal: false })
        await setStatus(sessionId, executionId, operationId('finalizing'), 'finalizing')
        const limitedContext = context ?? {
          symbol: job.symbol, facts: [], gaps: [{ capability: 'research_active', reason: 'budget_exhausted' }],
          indicators: {},
        }
        try {
          pauseProcessing()
          for await (const event of options.model.analyze({
            executionId, runtimeSettings, symbol: job.symbol,
            systemPrompt: ANALYSIS_SYSTEM_PROMPT,
            userPrompt: `研究 active time 已耗尽，请仅生成确定性受限报告。`,
            knownFacts: limitedContext.facts,
            fetchFinancialContext: async () => limitedContext,
            signal: controller.signal, executionDeadlineSignal: wallDeadline, activeBudget,
            acquireModelSlot: (signal) => modelGate.acquire(signal),
            acquireToolSlot: (signal) => toolGate.acquire(signal),
            toolRuntime,
          })) {
            if (event.type === 'lifecycle') await setStatus(sessionId, executionId, event.operationId, event.status, {
              terminal: event.status === 'budget_exhausted' ? false : undefined,
            }, event.waitTarget)
            if (event.type === 'trace' && (event.entry.type !== 'tool_result'
              || typeof event.entry.operationId !== 'string')) {
              await appendTrace(sessionId, executionId, event.entry.operationId ? event.entry : {
                ...event.entry, operationId: nextModelOperationId(event.entry.type),
              })
            }
            if (event.type === 'completed') {
              const report = enforceDataGaps(event.report, limitedContext.gaps ?? [])
              const reportVersion = event.reportVersion
                ? finalReportVersion(
                    executionId, event.reportVersion, report, 'partial', limitedContext.gaps ?? [],
                  )
                : undefined
              await setStatus(sessionId, executionId, operationId('status-partial'), 'partial', {
                report, ...(reportVersion ? { reportVersion } : {}),
              })
              return
            }
          }
          throw new Error('research_active_closure_required')
        } catch (closureError) {
          await setStatus(sessionId, executionId, operationId('status-failed'), 'failed', {
            error: closureError instanceof Error ? closureError.message : String(closureError),
          })
        }
      } else {
        await setStatus(sessionId, executionId, operationId('status-failed'), 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      processing.stop()
      controllers.delete(analysisId)
    }
  }
  async function cancel(analysisId: string) {
    const job = await get(analysisId)
    if (!job || !['queued', 'running'].includes(job.status)) return false
    const session = await options.eventRepository.findPrimarySession(analysisId)
    if (!session) return false
    const fenceExecutionId = randomUUID()
    const createdAt = new Date().toISOString()
    const waitReason = waitReasonForStatus('stopping', '运行时停止确认', createdAt)
    const event = await options.eventRepository.fenceForStopping({
      sessionId: session.id, executionId: session.executionId, fenceExecutionId,
      operationId: `session:${session.id}:stopping`,
      event: { type: 'status', status: 'stopping', terminal: false, waitReason, at: createdAt },
      createdAt,
    })
    for (const cancelled of event.cancelledToolEvents ?? []) {
      for (const listener of listeners.get(session.id) ?? []) listener(cancelled)
    }
    for (const listener of listeners.get(session.id) ?? []) listener(event)
    const controller = controllers.get(analysisId)
    controller?.abort()
    await analysisTasks.get(analysisId)
    await setStatus(session.id, fenceExecutionId, `session:${session.id}:stopped`, 'stopped')
    return true
  }
  async function research(analysisId: string) {
    await initialized
    const record = await repository.research(analysisId)
    if (!record) return null
    const session = await options.eventRepository.findPrimarySession(analysisId)
    const trace = session
      ? (await options.eventRepository.list(session.id, 0)).map(({ payload }) => payload)
      : []
    return {
      ...record, trace,
      mainAgent: await options.eventRepository.primaryLifecycle(analysisId),
    }
  }
  async function listResearch(symbol?: string) {
    await initialized
    return repository.listResearch(symbol)
  }
  async function updateResearch(analysisId: string, values: { starred?: boolean; note?: string }) {
    await initialized
    return repository.updateResearch(analysisId, values, new Date().toISOString())
  }
  async function removeResearch(analysisId: string) {
    await initialized
    return repository.removeResearch(analysisId)
  }
  async function *streamEvents(sessionId: string, afterSequence: number, signal?: AbortSignal) {
    await initialized
    const session = await options.eventRepository.getSession(sessionId)
    if (!session) return
    const queue: AgentEvent[] = []
    let wake: (() => void) | undefined
    const listener = (entry: AgentEvent) => {
      queue.push(entry)
      wake?.()
    }
    const subscriptions = listeners.get(sessionId) ?? new Set()
    subscriptions.add(listener)
    listeners.set(sessionId, subscriptions)
    try {
      let cursor = afterSequence
      const catchUp = await options.eventRepository.list(sessionId, afterSequence)
      for (const entry of catchUp) {
        cursor = entry.sequence
        yield entry
      }
      while (queue.length) {
        const entry = queue.shift()!
        if (entry.sequence <= cursor) continue
        cursor = entry.sequence
        yield entry
        if (entry.payload.type === 'status' && isTerminalEvent(entry.payload)) return
      }
      const current = await options.eventRepository.getSession(sessionId)
      if (!current) return
      if (isTerminalAgentExecutionStatus(current.status, true)) {
        const remaining = await options.eventRepository.list(sessionId, cursor)
        for (const entry of remaining) {
          cursor = entry.sequence
          yield entry
        }
        const latest = [...catchUp, ...remaining].at(-1)
        if (latest?.payload.type === 'status' && isTerminalEvent(latest.payload)) return
      }
      while (!signal?.aborted) {
        if (!queue.some(({ sequence }) => sequence > cursor)) {
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        wake = undefined
        while (queue.length) {
          const entry = queue.shift()!
          if (entry.sequence <= cursor) continue
          cursor = entry.sequence
          yield entry
          if (entry.payload.type === 'status' && isTerminalEvent(entry.payload)) return
        }
      }
    } finally {
      subscriptions.delete(listener)
      if (!subscriptions.size) listeners.delete(sessionId)
    }
  }
  async function close() {
    for (const controller of controllers.values()) controller.abort()
    await Promise.allSettled(tasks)
  }
  function updateRuntimePolicy(values: RuntimeSettings) {
    concurrency = values.analysisConcurrency
    modelGate.setLimit(values.modelConcurrency)
    toolGate.setLimit(values.toolConcurrency)
    queueMicrotask(() => void schedule())
  }
  return { create, get, cancel, research, listResearch, updateResearch, removeResearch, streamEvents, close, updateRuntimePolicy }
}

function isExecutionStatus(value: string): value is import('@vibe-invest/contracts').AgentExecutionStatus {
  return agentExecutionStatuses.includes(value as import('@vibe-invest/contracts').AgentExecutionStatus)
}

function waitTarget(status: AgentExecutionStatus) {
  return ({
    planning: '研究规划', running_model: '主模型响应', running_tools: '工具结果',
    waiting_for_specialists: '专项分析', finalizing: '报告收口',
    stopping: '停止当前执行',
  } as Partial<Record<AgentExecutionStatus, string>>)[status] ?? ''
}

const ANALYSIS_SYSTEM_PROMPT = `你是个人美股研究助手，分析周期为未来一至四周。
你可以自主规划分析路径。建议先确认本次冻结的金融上下文；按需调用 fetch_financial_context，遇到需要深入解释财报时可调用 analyze_financials。财报专家可通过受控工具补查关键词新闻和指定日期范围的技术指标。只能使用提供的只读工具，最终必须调用 submit_analysis_report 提交报告。
不得编造行情、新闻、财报、估值或持仓；所有事实判断只能引用工具结果中真实存在的事实 ID。
每条 keyJudgments 都必须关联一个或多个事实 ID；supportingEvidence 和 contraryEvidence 也必须引用事实 ID。
财报增长率、利润率、TTM、自由现金流、质量标记、技术指标与估值结果由宿主程序计算，你只负责解释，不重新计算或改写输入数字。
必须区分“当前估值倍数”和“目标价估值方法”：目标价方法不可用不等于当前 PE 等倍数不可用。
模型上下文中的日线是冻结快照的裁剪样本，不得据此声称数据源只有这些交易日；以 contextScope 中的数量说明裁剪范围。
数据不足时明确写入 limitations；缺行情不得判断走势，缺财报或估值输入不得给目标价，缺新闻不得推断新闻驱动。
操作建议只能是带前提的方向建议，不给具体股数或无条件买卖指令。`

function sourceDegradations(context: FinancialContext) {
  return Object.entries(context).flatMap(([capability, value]) => {
    if (!value || typeof value !== 'object' || !('degraded' in value) || !value.degraded) return []
    const sources = 'sources' in value && Array.isArray(value.sources) ? value.sources : []
    return [{ capability, sources }]
  })
}

function sourceDiagnostics(context: FinancialContext) {
  const capabilities = Object.entries(context).flatMap(([capability, value]) => {
    if (!value || typeof value !== 'object' || !('sources' in value) || !Array.isArray(value.sources)) return []
    const record = value as Record<string, unknown>
    const acceptedCount = Array.isArray(record.items)
      ? record.items.length
      : record.value === null || record.value === undefined ? 0 : 1
    return [{
      capability,
      adoptedSource: typeof record.adopted_source === 'string' ? record.adopted_source : null,
      acceptedCount,
      sources: value.sources,
    }]
  })
  const valuationSources = Array.isArray(context.valuation_sources) ? context.valuation_sources : []
  if (valuationSources.length) capabilities.push({
    capability: 'valuation', adoptedSource: context.valuation ? valuationSources[0]?.source ?? null : null,
    acceptedCount: context.valuation ? 1 : 0, sources: valuationSources,
  })
  return capabilities
}

function isTerminalEvent(payload: Record<string, unknown>) {
  return isTerminalAgentExecutionStatus(
    String(payload.status), typeof payload.terminal === 'boolean' ? payload.terminal : undefined,
  )
}

function enforceDataGaps(report: AnalysisReport, gaps: unknown[]) {
  const capabilities = new Set(gaps.flatMap((gap) => (
    gap && typeof gap === 'object' && typeof (gap as { capability?: unknown }).capability === 'string'
      ? [(gap as { capability: string }).capability]
      : []
  )))
  const limitations = [...report.limitations]
  const add = (message: string) => { if (!limitations.includes(message)) limitations.push(message) }
  let result = { ...report, limitations }
  if (capabilities.has('quote') || capabilities.has('history')) {
    add('当前行情或历史行情缺失，无法生成走势判断')
    result = { ...result, marketState: '关键行情数据缺失', trend: '无法生成走势判断' }
  }
  if (capabilities.has('fundamentals') || capabilities.has('valuation')) {
    add('财报或估值输入缺失，未生成目标价')
    result = { ...result, valuation: null }
  }
  if (capabilities.has('news')) add('近期新闻不可用，无法判断新闻驱动')
  if (capabilities.has('portfolio_prices')) add('组合内部分持仓缺少当前价格，无法计算准确仓位占比和集中度')
  return result
}

function finalReportVersion(
  executionId: string,
  candidate: NonNullable<Extract<ModelEvent, { type: 'completed' }>['reportVersion']>,
  report: AnalysisReport,
  status: 'completed' | 'partial',
  gaps: unknown[],
) {
  const candidateGaps = Array.isArray(candidate.report.gaps) ? candidate.report.gaps : []
  const payload = {
    ...candidate.report,
    status,
    availability: status === 'partial' ? 'partial' : candidate.report.availability,
    gaps: [...candidateGaps, ...gaps], limitations: report.limitations,
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return {
    id: `${executionId}:report:${payloadHash}`,
    kind: candidate.kind,
    payloadHash,
    report: payload,
  }
}

function createModelContext(snapshot: FinancialContext & Record<string, unknown>) {
  const dailyBars = snapshot.facts.filter((fact) => fact.type === 'daily_bar')
  const news = snapshot.facts.filter((fact) => fact.type === 'news').slice(0, 8)
  const financialSummary = createFinancialSummary(snapshot.fundamentals)
  const financialFactIds = collectFinancialFactIds(financialSummary, snapshot.facts)
  const relevantFacts = snapshot.facts.filter((fact) => (
    fact.type !== 'daily_bar'
    && fact.type !== 'news'
    && (!isFinancialFact(fact) || financialFactIds.has(fact.id))
  ))
  const sampledHistory = [...dailyBars.slice(-20)]
  return {
    symbol: snapshot.symbol,
    facts: [...relevantFacts, ...news, ...sampledHistory],
    gaps: snapshot.gaps ?? [],
    indicators: snapshot.indicators,
    financials: financialSummary,
    valuation: snapshot.valuation,
    portfolioContext: snapshot.portfolioContext,
    contextScope: {
      snapshotDailyBarCount: dailyBars.length,
      providedDailyBarCount: sampledHistory.length,
      note: '日线仅为冻结快照的上下文裁剪样本，不代表数据源总历史长度。',
    },
    createdAt: snapshot.createdAt,
  }
}

function createInitialRuntimeContext(
  modelContext: ReturnType<typeof createModelContext>, personalContext: unknown,
): NonNullable<AnalyzeInput['runtimeContext']> {
  const quote = modelContext.facts.find((fact) => fact.type === 'quote')
  const dailyBars = modelContext.facts.filter((fact) => fact.type === 'daily_bar')
  const unavailable = new Map((modelContext.gaps as Array<Record<string, unknown>>).flatMap((gap) => (
    typeof gap.capability === 'string' ? [[gap.capability, gap.reason ?? 'unavailable'] as const] : []
  )))
  const capability = (name: string, available: boolean) => unavailable.has(name)
    ? { status: 'unavailable', reason: unavailable.get(name) }
    : { status: available ? 'available' : 'unavailable' }
  const financials = modelContext.financials as { quarters?: Array<Record<string, unknown>> } | null
  const evidenceFacts = modelContext.facts.filter((fact) => fact.type !== 'daily_bar')
  return {
    role: 'runtime_context', generatedBy: 'product_runtime', isUserInput: false,
    content: {
      symbol: modelContext.symbol,
      analysisPeriod: '未来一至四周',
      marketSummary: { currentPrice: typeof quote?.value === 'number' ? quote.value : null },
      recentDailyBars: dailyBars,
      evidenceFacts,
      latestFinancialPeriod: financials?.quarters?.[0]
        ? periodName(financials.quarters[0]) ?? null : null,
      capabilityStatus: {
        quote: capability('quote', Boolean(quote)),
        history: capability('history', dailyBars.length > 0),
        fundamentals: capability('fundamentals', Boolean(modelContext.financials)),
        news: capability('news', modelContext.facts.some((fact) => fact.type === 'news')),
        valuation: capability('valuation', modelContext.valuation !== null && modelContext.valuation !== undefined),
      },
      personalContext,
      availableTools: analysisModelTools.map(({ name, description }) => ({ name, purpose: description })),
      specialistCapabilities: [
        { domain: 'news', responsibility: '核实消息、公司事件及相反证据' },
        { domain: 'fundamental_valuation', responsibility: '解释财务表现、估值输入与数据缺口' },
        { domain: 'technical', responsibility: '解释多周期量价与确定性技术指标' },
      ],
      finalReportGoal: '基于合格事实提交候选结构化综合报告；缺失资料形成明确限制，不补造结论。',
    },
  }
}

function createFinancialSummary(fundamentals: unknown) {
  if (!fundamentals || typeof fundamentals !== 'object') return null
  const value = (fundamentals as { value?: unknown }).value
  if (!value || typeof value !== 'object') return null
  const financials = value as Record<string, unknown>
  const quarters = Array.isArray(financials.quarters) ? financials.quarters : []
  const annuals = Array.isArray(financials.annuals) ? financials.annuals : []
  const latestPeriod = periodName(quarters[0])
  const priorYearPeriod = latestPeriod?.replace(/^(CY|FY)(\d{4})/, (_match, prefix, year) => `${prefix}${Number(year) - 1}`)
  const selectedQuarters = [quarters[0], quarters[1], quarters.find((period) => periodName(period) === priorYearPeriod)]
    .filter((period, index, selected) => period && selected.indexOf(period) === index)
  const derivedMetrics = Array.isArray(financials.derived_metrics)
    ? financials.derived_metrics.filter((metric) => {
        if (!metric || typeof metric !== 'object') return false
        const candidate = metric as Record<string, unknown>
        return candidate.scope === 'ttm' || candidate.period === latestPeriod
      })
    : []
  return {
    quarters: selectedQuarters,
    ttm: financials.ttm ?? null,
    annuals: annuals.slice(0, 3),
    derivedMetrics,
    qualityFlags: financials.quality_flags ?? [],
  }
}

function collectFinancialFactIds(summary: unknown, facts: FinancialFact[]) {
  const selected = new Set<string>()
  collectIds(summary, selected)
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const queue = [...selected]
  while (queue.length) {
    const fact = byId.get(queue.shift()!)
    if (!fact || !fact.value || typeof fact.value !== 'object') continue
    const record = fact.value as Record<string, unknown>
    for (const input of [...asStrings(record.inputFactIds), ...asStrings(record.evidenceFactIds)]) {
      if (!selected.has(input)) { selected.add(input); queue.push(input) }
    }
  }
  return selected
}

function collectIds(value: unknown, ids: Set<string>) {
  if (Array.isArray(value)) { for (const item of value) collectIds(item, ids); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'fact_id' || key === 'factId') && typeof item === 'string') ids.add(item)
    else if ((key === 'input_fact_ids' || key === 'evidence_fact_ids') && Array.isArray(item)) {
      for (const id of item) if (typeof id === 'string') ids.add(id)
    } else collectIds(item, ids)
  }
}

function isFinancialFact(fact: FinancialFact) {
  return ['reported_financial', 'derived_financial_metric', 'financial_quality_flag'].includes(fact.type)
}

function periodName(value: unknown) {
  return value && typeof value === 'object' && typeof (value as { period?: unknown }).period === 'string'
    ? (value as { period: string }).period
    : null
}

function asStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
