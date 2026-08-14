import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentEvent, AgentEventRepository, AgentSession, AnalysisRepository, RuntimeSettingsRepository,
  ToolProjectionRepository,
} from '@vibe-invest/product-dao'
import {
  agentExecutionStatuses, defaultRuntimeSettings, isTerminalAgentExecutionStatus,
  waitReasonForStatus,
  type AgentExecutionStatus, type RuntimeSettings,
} from '@vibe-invest/contracts'

import type {
  AnalyzeFundamentalInput, AnalyzeInput, AnalyzeNewsInput, AnalyzeTechnicalInput,
  AnalysisReport, ModelEvent, ToolRuntime,
} from './model.js'
import type {
  FactQueryResult, FinancialContext, FinancialFact, PaginatedFactQueryResult,
} from './financial-data-client.js'
import {
  acquireActiveSlot, createActiveBudget, createConcurrencyGate, raceWithAbort,
} from './runtime-policy.js'
import {
  analysisModelTools, financialSpecialistTools, newsSpecialistTools, technicalSpecialistTools,
} from './tools.js'
import { toolRegistry } from './tool-registry.js'

type Fact = FinancialFact
type SpecialistDomain = 'news' | 'fundamental_valuation' | 'technical'
type Model = {
  analyze(input: AnalyzeInput): AsyncIterable<ModelEvent>
  analyzeNews?: (input: AnalyzeNewsInput) => AsyncIterable<ModelEvent>
  analyzeFundamental?: (input: AnalyzeFundamentalInput) => AsyncIterable<ModelEvent>
  analyzeTechnical?: (input: AnalyzeTechnicalInput) => AsyncIterable<ModelEvent>
}

export function createAnalysisService(options: {
  repository: AnalysisRepository
  eventRepository: AgentEventRepository
  settingsRepository: RuntimeSettingsRepository
  toolProjectionRepository: ToolProjectionRepository
  model: Model
  fetchFinancialContext: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchNewsCandidates?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchWebEvidence?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  readNewsDocument?: (candidate: Fact, signal: AbortSignal) => Promise<FactQueryResult>
  listCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  listOfficialCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  getFinancialOverview?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; overview: Record<string, unknown>; sources?: unknown[] }>
  getFinancialMetricSeries?: (
    symbol: string, metric: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  getValuationEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; [key: string]: unknown }>
  getTechnicalEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: FinancialFact[]; [key: string]: unknown }>
  getPriceWindow?: (
    symbol: string, startDate: string, endDate: string,
    cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  readFilingDocument?: (
    symbol: string, filingId: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
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
  const stoppingTasks = new Map<string, Promise<boolean>>()
  const deletionTasks = new Map<string, Promise<boolean>>()
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
        causativeEvent: input.causativeEvent,
        createdAt: input.createdAt,
      })
      if (projection.event) {
        for (const listener of listeners.get(projection.event.sessionId) ?? []) listener(projection.event)
      }
      return { id: projection.id, version: projection.version }
    },
    async recordModelRequest(input) {
      await options.toolProjectionRepository.recordModelRequest({
        id: input.requestId, executionId: input.executionId, projectionId: input.projectionId,
        turnIndex: input.turnIndex, kind: input.kind, createdAt: input.createdAt,
      })
    },
    async completeModelRequest(input) {
      await options.toolProjectionRepository.completeModelRequest({
        id: input.requestId, executionId: input.executionId, status: input.status,
        usageStatus: input.usageStatus, usage: input.usage, completedAt: input.completedAt,
      })
    },
    async beginToolBatch(input) {
      await options.toolProjectionRepository.beginToolBatch(input)
    },
    async startToolCall(input) {
      const event = await options.toolProjectionRepository.startToolCall(input)
      for (const listener of listeners.get(event.sessionId) ?? []) listener(event)
    },
    async completeToolBatch(input) {
      const visibleToolNames = input.advance?.tools.map(({ name }) => name)
      const completed = await options.toolProjectionRepository.completeToolBatch({
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
        ...(input.advance ? { advance: {
          role: input.advance.role, stage: input.advance.stage,
          schemaHash: createHash('sha256').update(JSON.stringify(input.advance.tools)).digest('hex'),
          projectedTools: input.advance.tools, visibleToolNames: visibleToolNames!,
          reasons: { role: input.advance.role, stage: input.advance.stage },
          toolRounds: input.advance.toolRounds, activeElapsedMs: input.advance.activeElapsedMs,
          causativeEvent: input.advance.causativeEvent,
        } } : {}),
      })
      for (const event of completed.events) {
        for (const listener of listeners.get(event.sessionId) ?? []) listener(event)
      }
      return { projection: completed.projection
        ? { id: completed.projection.id, version: completed.projection.version } : undefined }
    },
    async commitCompaction(input) {
      const committed = await options.eventRepository.commitCompaction(input)
      if (committed.event) {
        for (const listener of listeners.get(committed.event.sessionId) ?? []) {
          listener(committed.event)
        }
      }
    },
    async failCompaction(input) {
      const committed = await options.eventRepository.failCompaction(input)
      if (committed.event) for (const listener of listeners.get(committed.event.sessionId) ?? []) {
        listener(committed.event)
      }
    },
    async recordCompactionAttempt(input) {
      await options.eventRepository.recordCompactionAttempt(input)
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
        snapshot?: unknown
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
      const remainingWallMs = wallBudgetMs - (Date.now() - Date.parse(settingsSnapshot.createdAt))
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
    let adoptedFacts: Fact[] = []
    let terminalSnapshotBase: Record<string, unknown> = {}
    let followUpEvent: Record<string, unknown> | undefined
    const specialistOutcomes = new Map<SpecialistDomain, Record<string, unknown>>()
    const refreshKnownFacts = async () => {
      const research = await repository.research(analysisId)
      adoptedFacts = (research?.facts ?? []) as Fact[]
      return adoptedFacts
    }
    const rememberSpecialistOutcome = (
      domain: SpecialistDomain, outcome: Record<string, unknown>,
    ) => { specialistOutcomes.set(domain, outcome) }
    const terminalSnapshot = () => ({ ...terminalSnapshotBase, facts: adoptedFacts })
    const nextModelOperationId = (kind: string) => (
      `execution:${executionId}:model:${++modelEventSequence}:${kind}`
    )
    try {
      const currentLifecycle = await options.eventRepository.primaryLifecycle(analysisId)
      const resumeEvent = currentLifecycle?.events.findLast((event) => {
        const payload = event as Record<string, unknown>
        return payload.type === 'runtime_resume' && payload.executionId === executionId
      }) as (Record<string, unknown> | undefined)
      const directFollowUpEvent = currentLifecycle?.events.findLast((event) => {
        const payload = event as Record<string, unknown>
        return payload.type === 'runtime_follow_up' && payload.executionId === executionId
      }) as (Record<string, unknown> | undefined)
      const resumedFollowUp = resumeEvent?.followUp
      followUpEvent = directFollowUpEvent ?? (resumedFollowUp
        && typeof resumedFollowUp === 'object' && !Array.isArray(resumedFollowUp)
        ? { ...resumedFollowUp as Record<string, unknown>, executionId }
        : undefined)
      const reportUpdateRequested = followUpEvent?.updateReport === true
      const reportVersions = await options.eventRepository.listReportVersions(analysisId)
      const baseReportVersion = typeof followUpEvent?.baseReportVersion === 'number'
        ? followUpEvent.baseReportVersion : null
      const baseReport = baseReportVersion === null ? undefined : reportVersions.find((version) => (
        version.sessionId === sessionId && version.kind === 'integrated'
          && version.version === baseReportVersion
      ))
      const continuationEvent = followUpEvent ?? resumeEvent
      const restoredResearch = continuationEvent ? await repository.research(analysisId) : undefined
      const activeSnapshot = job.snapshot && typeof job.snapshot === 'object'
        ? job.snapshot as FinancialContext & { portfolioContext?: unknown } : undefined
      const baseSnapshot = baseReport
        ? baseReport.snapshot && typeof baseReport.snapshot === 'object'
          ? baseReport.snapshot as FinancialContext & { portfolioContext?: unknown }
          : {
              symbol: job.symbol, facts: [], indicators: {}, portfolioContext: null,
              gaps: [{ capability: 'base_report_snapshot', reason: 'unavailable' }],
            }
        : activeSnapshot
      const restoredSnapshot = continuationEvent && !reportUpdateRequested && baseSnapshot
        ? {
            ...baseSnapshot,
            facts: followUpEvent
              ? baseSnapshot.facts
              : (restoredResearch?.facts ?? baseSnapshot.facts) as Fact[],
          } : undefined
      if (restoredSnapshot) context = restoredSnapshot
      else {
        pauseProcessing()
        const contextOwner = await acquireActiveSlot({
          acquire: () => toolGate.acquire(executionSignal), activeBudget, signal: executionSignal,
        })
        try {
          context = await raceWithAbort(
            () => options.fetchFinancialContext(job.symbol, contextOwner.signal), contextOwner.signal,
          )
        } finally {
          contextOwner.finish()
        }
        resumeProcessing()
      }
      assertPolicy()
      if (!context) throw new Error('financial_context_unavailable')
      if (reportUpdateRequested && restoredResearch?.facts.length) {
        const refreshedFactIds = new Set(context.facts.map(({ id }) => id))
        context = {
          ...context,
          facts: [...context.facts, ...(restoredResearch.facts as Fact[]).filter(({ id }) => (
            !refreshedFactIds.has(id)
          ))],
        }
      }
      const quoteFact = context.facts.find((fact) => fact.type === 'quote' && typeof fact.value === 'number')
      let portfolioPrices: Record<string, number> = {}
      let portfolioPriceGap = false
      if ((!restoredSnapshot || followUpEvent)
        && options.fetchMarketPrices && options.listPortfolioSymbols) {
        try {
          pauseProcessing()
          const pricesOwner = await acquireActiveSlot({
            acquire: () => toolGate.acquire(executionSignal), activeBudget, signal: executionSignal,
          })
          try {
            const fetchMarketPrices = options.fetchMarketPrices
            const listPortfolioSymbols = options.listPortfolioSymbols
            portfolioPrices = await raceWithAbort(async () => fetchMarketPrices!(
              await listPortfolioSymbols!(), pricesOwner.signal,
            ), pricesOwner.signal,
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
      const portfolioContext = followUpEvent
        ? await options.getPortfolioContext?.(job.symbol, portfolioPrices)
          ?? { position: null, portfolio: null }
        : restoredSnapshot?.portfolioContext
          ?? await options.getPortfolioContext?.(job.symbol, portfolioPrices)
          ?? { position: null, portfolio: null }
      const gaps = [
        ...(context.gaps ?? []),
        ...(portfolioPriceGap ? [{ capability: 'portfolio_prices', reason: 'source_unavailable' }] : []),
      ]
      const snapshot = { ...context, gaps, portfolioContext, createdAt: new Date().toISOString() }
      terminalSnapshotBase = snapshot
      adoptedFacts = snapshot.facts
      if (!followUpEvent) await appendEvent(sessionId, executionId, operationId('financial-context'), {
          type: 'financial_context',
          gaps,
          capabilities: sourceDiagnostics(context),
          degradedSources: sourceDegradations(context),
        }, { snapshot, facts: context.facts })
      assertPolicy()
      const modelContext = createModelContext(snapshot)
      const runtimeContext = createInitialRuntimeContext(modelContext, portfolioContext)
      const previousExecutionId = typeof resumeEvent?.previousExecutionId === 'string'
        ? resumeEvent.previousExecutionId : undefined
      const sourceExecutionIds = Array.isArray(resumeEvent?.sourceExecutionIds)
        ? resumeEvent.sourceExecutionIds.filter((id): id is string => typeof id === 'string') : []
      const previousRuntimes = await Promise.all(sourceExecutionIds.map(
        (sourceExecutionId) => options.toolProjectionRepository.replay(sourceExecutionId),
      ))
      const knownFactIds = new Set(modelContext.facts.map((fact) => fact.id))
      const reusableToolResults = reusableResults(
        previousRuntimes, knownFactIds, modelContext.facts,
        'main', analysisModelTools.map(({ name }) => name),
      )
      const specialistSessions = (await options.eventRepository.listSessions(analysisId))
        .filter(({ isPrimary }) => !isPrimary)
      const specialistLifecycles = new Map(await Promise.all(specialistSessions.map(async (specialist) => (
        [specialist.id, await options.eventRepository.sessionLifecycle(specialist.id)] as const
      ))))
      const specialistDomains = new Map(specialistSessions.flatMap((specialist) => {
        const lifecycle = specialistLifecycles.get(specialist.id)
        const domainEvent = lifecycle?.events.find((event) => {
          const payload = event as Record<string, unknown>
          return ['news', 'fundamental_valuation', 'technical'].includes(String(payload.domain))
        }) as Record<string, unknown> | undefined
        return domainEvent ? [[specialist.id, domainEvent.domain as SpecialistDomain] as const] : []
      }))
      const reusableSpecialistReports = specialistSessions.flatMap((specialist) => {
        const version = reportVersions.filter(({ sessionId: id }) => id === specialist.id).at(-1)
        if (!version) return []
        const report = version.report as Record<string, unknown>
        return [{
          domain: typeof report.domain === 'string' ? report.domain : 'unknown',
          sessionId: specialist.id, executionId: version.executionId,
          reportId: version.id, version: version.version,
          status: report.status === 'partial' ? 'partial' : 'completed',
        }]
      })
      const priorSpecialistOutcomes = reusableSpecialistReports.flatMap((report) => (
        ['news', 'fundamental_valuation', 'technical'].includes(report.domain) ? [{
          domain: report.domain as SpecialistDomain,
          outcome: {
            launched: true, reused: true, status: report.status,
            sessionId: report.sessionId, executionId: report.executionId,
            reportId: report.reportId, reportVersion: report.version,
            summary: '沿用基准报告已封存的专项版本', keyFactIds: [], contraryFactIds: [], gaps: [],
          },
        }] : []
      ))
      for (const { domain, outcome } of priorSpecialistOutcomes) {
        specialistOutcomes.set(domain, outcome)
      }
      const specialistStatuses = (['news', 'fundamental_valuation', 'technical'] as const).map((domain) => {
        const specialist = specialistSessions.find((candidate) => (
          specialistDomains.get(candidate.id) === domain
        ))
        const reusable = reusableSpecialistReports.find((candidate) => candidate.domain === domain)
        const lifecycle = specialist ? specialistLifecycles.get(specialist.id) : undefined
        return {
          domain,
          status: reusable?.status ?? lifecycle?.execution.status ?? 'not_started',
          ...(specialist ? { sessionId: specialist.id } : {}),
          ...(reusable ? { reportId: reusable.reportId, version: reusable.version } : {}),
        }
      })
      const specialistRecovery = new Map<SpecialistDomain, NonNullable<AnalyzeInput['runtimeResume']>>()
      for (const specialist of specialistSessions) {
        if (reusableSpecialistReports.some(({ sessionId: id }) => id === specialist.id)) continue
        const lifecycle = specialistLifecycles.get(specialist.id)
        const domainEvent = lifecycle?.events.find((event) => {
          const payload = event as Record<string, unknown>
          return ['news', 'fundamental_valuation', 'technical'].includes(String(payload.domain))
        }) as Record<string, unknown> | undefined
        const previousEvent = lifecycle?.events.findLast((event) => (
          typeof (event as Record<string, unknown>).previousExecutionId === 'string'
        )) as Record<string, unknown> | undefined
        const domain = domainEvent?.domain as SpecialistDomain | undefined
        const previous = previousEvent?.previousExecutionId ?? lifecycle?.execution.id
        if (!domain || typeof previous !== 'string') continue
        const replay = await options.toolProjectionRepository.replay(previous)
        specialistRecovery.set(domain, {
          role: 'runtime_resume', generatedBy: 'product_runtime', isUserInput: false,
          content: {
            previousExecutionId: previous,
            ...latestCompactionSummary(lifecycle),
            reusableToolResults: reusableResults(
              [replay], knownFactIds, modelContext.facts,
              domain === 'fundamental_valuation' ? 'fundamental' : domain,
              specialistToolNames(domain),
            ),
            unresolved: unresolvedResults([replay]),
          },
        })
      }
      const runtimeResume = previousExecutionId ? {
        role: 'runtime_resume' as const, generatedBy: 'product_runtime' as const,
        isUserInput: false as const,
        content: {
          previousExecutionId, executionId,
          ...latestCompactionSummary(currentLifecycle),
          reusableToolResults, reusableSpecialistReports,
          unresolved: unresolvedResults(previousRuntimes),
        },
      } : undefined
      const reportCreatedAt = baseReport?.createdAt ?? job.reportCreatedAt
      const reportAgeDays = reportCreatedAt
        ? Math.max(0, (Date.now() - Date.parse(reportCreatedAt)) / 86_400_000) : null
      const updateReport = reportUpdateRequested
      const freshness = reportAgeDays === null ? 'unavailable'
        : reportAgeDays > runtimeSettings.reportFreshnessDays ? 'stale' : 'current'
      const latestCompaction = currentLifecycle?.compactions.at(-1)
      const latestCompactionEvent = currentLifecycle?.events.findLast((event) => (
        (event as Record<string, unknown>).type === 'compaction'
          && (event as Record<string, unknown>).status === 'completed'
      ))
      const historyCutoff = latestCompaction ? Date.parse(latestCompaction.createdAt) : Number.NEGATIVE_INFINITY
      const historySequenceCutoff = latestCompactionEvent?.sequence ?? Number.NEGATIVE_INFINITY
      const conversationHistory = (currentLifecycle?.events ?? []).reduce<Array<{
        role: 'user' | 'assistant'; text: string
      }>>((history, event) => {
        if (latestCompactionEvent ? event.sequence <= historySequenceCutoff
          : Date.parse(event.createdAt) <= historyCutoff) return history
        const payload = event as Record<string, unknown>
        if (payload.type === 'runtime_follow_up'
          && payload.messageId !== followUpEvent?.messageId
          && typeof payload.message === 'string') {
          history.push({ role: 'user', text: payload.message })
        }
        if (payload.type === 'chat_completed' && typeof payload.text === 'string') {
          history.push({ role: 'assistant', text: payload.text })
        }
        return history
      }, [])
      const runtimeFollowUp = followUpEvent ? {
        role: 'runtime_follow_up' as const,
        generatedBy: 'product_runtime' as const,
        isUserInput: false as const,
        content: {
          message: String(followUpEvent.message ?? ''),
          updateReport,
          intent: updateReport ? 'request_report_update' as const : 'chat' as const,
          conversationHistory,
          ...(resumeEvent ? {} : latestCompactionSummary(currentLifecycle)),
          baseReportVersion,
          baseReport: baseReport?.report ?? null,
          baseReportCreatedAt: reportCreatedAt,
          reportAgeDays,
          freshness,
          freshnessWarning: freshness === 'stale'
            ? `基准报告可能过期：已超过 ${runtimeSettings.reportFreshnessDays} 天时效阈值。`
            : null,
          reportPositionContext: baseReport
            ? (baseReport.snapshot as { portfolioContext?: unknown } | null)
              ?.portfolioContext ?? null
            : (job.snapshot as { portfolioContext?: unknown } | null)
              ?.portfolioContext ?? null,
          currentPositionSummary: portfolioContext,
          specialistStatuses,
          availableTools: analysisModelTools.filter(({ name }) => (
            updateReport || name !== 'submit_analysis_report'
          )).map(({ name, description }) => ({
            name, purpose: description,
          })),
        },
      } : undefined
      const newsRuntimeAvailable = Boolean(options.model.analyzeNews && options.searchNewsCandidates
        && options.readNewsDocument && options.listCompanyEvents)
      const fundamentalRuntimeAvailable = Boolean(options.model.analyzeFundamental
        && options.getFinancialOverview && options.getFinancialMetricSeries
        && options.getValuationEvidence && options.readFilingDocument
        && options.listOfficialCompanyEvents)
      const technicalRuntimeAvailable = Boolean(options.model.analyzeTechnical
        && options.getTechnicalEvidence && options.getPriceWindow)
      type SpecialistRequest = {
        launch: boolean; researchQuestion: string; reason: string
        prepared?: { sessionId: string; executionId: string; created: boolean }
      }
      const prepareSpecialist = async (request: {
        domain: SpecialistDomain; researchQuestion: string; reason: string
      }) => {
        if (runtimeResume) {
          const reusable = reusableSpecialistReports.find(({ domain }) => domain === request.domain)
          if (reusable) {
            const existing = specialistSessions.find(({ id }) => id === reusable.sessionId)!
            return {
              domain: request.domain, sessionId: existing.id,
              executionId: existing.executionId, created: false,
            }
          }
        }
        const requestedSessionId = randomUUID()
        const requestedExecutionId = randomUUID()
        const createdAt = new Date().toISOString()
        const prepared = await options.eventRepository.createSpecialistSession({
          id: requestedSessionId, analysisId, executionId: requestedExecutionId,
          domain: request.domain, segmentId: randomUUID(), status: 'planning',
          operationId: `execution:${requestedExecutionId}:specialist-context`,
          event: {
            type: 'specialist_context', domain: request.domain, launch: true,
            researchQuestion: request.researchQuestion, reason: request.reason,
            status: 'planning', at: createdAt,
          },
          createdAt,
        })
        return { domain: request.domain, ...prepared }
      }
      const prepareSpecialistBatch = async (requests: Array<{
        domain: SpecialistDomain; researchQuestion: string; reason: string
      }>, batchId: string) => {
        const domains = requests.map(({ domain }) => domain)
        if (new Set(domains).size !== domains.length) {
          throw new Error('duplicate_specialist_domain_in_batch')
        }
        const prepared = await Promise.all(requests.map(prepareSpecialist))
        await setStatus(
          sessionId, executionId, `${batchId}:waiting-for-specialists`,
          'waiting_for_specialists', {},
          `专项 Session：${prepared.map(({ sessionId }) => sessionId).join('、')}`,
        )
        return prepared
      }
      const runSpecialistLifecycle = async (config: {
        domain: SpecialistDomain
        label: string
        request: SpecialistRequest
        events: (
          executionId: string, runtime: ToolRuntime, activeBudget: ReturnType<typeof createActiveBudget>,
          executionDeadlineSignal: AbortSignal,
        ) => AsyncIterable<ModelEvent>
      }) => {
        const specialistSession = config.request.prepared ?? await (async () => {
          const prepared = await prepareSpecialist({
            domain: config.domain, researchQuestion: config.request.researchQuestion,
            reason: config.request.reason,
          })
          await setStatus(
            sessionId, executionId, `execution:${executionId}:${config.domain}:waiting`,
            'waiting_for_specialists', {}, `专项 Session：${prepared.sessionId}`,
          )
          return prepared
        })()
        if (!specialistSession.created) {
          const versions = await options.eventRepository.listReportVersions(analysisId)
          const existing = versions.filter(
            ({ sessionId }) => sessionId === specialistSession.sessionId,
          ).at(-1)
          const existingStatus = existing
            && (existing.report as Record<string, unknown>).status === 'partial'
            ? 'partial' : 'completed'
          return {
            launched: true, status: existing ? existingStatus : 'not_started',
            sessionId: specialistSession.sessionId, executionId: specialistSession.executionId,
            ...(existing ? { reportId: existing.id, reportVersion: existing.version } : {}),
            summary: config.request.researchQuestion,
            keyFactIds: [], contraryFactIds: [], gaps: [],
          }
        }
        const specialistSessionId = specialistSession.sessionId
        const specialistExecutionId = specialistSession.executionId
        let specialistStatus = 'failed'
        let specialistReportVersion: ReturnType<typeof finalReportVersion> | undefined
        let specialistReportNumber: number | undefined
        const specialistActiveBudget = createActiveBudget(
          runtimeSettings.researchActiveMinutes * (options.runtimeMinuteMs ?? 60_000),
          options.activeNow, options.activeTimeoutSignal,
        )
        const specialistWallDeadline = AbortSignal.timeout(
          runtimeSettings.executionWallClockMinutes * (options.runtimeMinuteMs ?? 60_000),
        )
        try {
          await setStatus(
            specialistSessionId, specialistExecutionId,
            `execution:${specialistExecutionId}:running-model`,
            'running_model', {}, `${config.label}专项模型`,
          )
          for await (const specialistEvent of config.events(
            specialistExecutionId, toolRuntime, specialistActiveBudget, specialistWallDeadline,
          )) {
            if (specialistEvent.type === 'lifecycle') await setStatus(
              specialistSessionId, specialistExecutionId, specialistEvent.operationId,
              specialistEvent.status, {
                terminal: specialistEvent.status === 'budget_exhausted' ? false : undefined,
              }, specialistEvent.waitTarget,
            )
            else if (specialistEvent.type === 'trace'
              && (!['tool_result', 'compaction', 'context_usage'].includes(specialistEvent.entry.type)
                || typeof specialistEvent.entry.operationId !== 'string')) {
              await appendTrace(specialistSessionId, specialistExecutionId, specialistEvent.entry)
            }
            else if (specialistEvent.type === 'text_delta') await appendTrace(
              specialistSessionId, specialistExecutionId, specialistEvent.operationId
                ? specialistEvent : {
                    ...specialistEvent,
                    operationId: `execution:${specialistExecutionId}:text:${Date.now()}`,
                  },
            )
            else if (specialistEvent.type === 'completed' && specialistEvent.reportVersion) {
              const candidate = specialistEvent.reportVersion
              const candidateReport = candidate.report as Record<string, unknown>
              const status = candidateReport.status === 'partial' ? 'partial' : 'completed'
              specialistStatus = status
              specialistReportVersion = finalReportVersion(
                specialistExecutionId, candidate, specialistEvent.report, status, [],
              )
              await setStatus(
                specialistSessionId, specialistExecutionId,
                `execution:${specialistExecutionId}:status-${status}`, status,
                { reportVersion: specialistReportVersion },
              )
              specialistReportNumber = (await options.eventRepository.listReportVersions(analysisId))
                .find(({ id }) => id === specialistReportVersion!.id)?.version
              if (!specialistReportNumber) throw new Error('specialist_report_version_not_found')
            }
            else if (specialistEvent.type === 'cancelled') {
              specialistStatus = 'cancelled'
              await setStatus(
                specialistSessionId, specialistExecutionId,
                `execution:${specialistExecutionId}:status-stopped`, 'stopped',
              )
              return {
                launched: true, status: 'cancelled', sessionId: specialistSessionId,
                executionId: specialistExecutionId, summary: `${config.label}专项已取消`,
                keyFactIds: [], contraryFactIds: [],
                gaps: [{
                  capability: config.domain, reason: 'specialist_execution_cancelled',
                  impact: '该专项未形成报告',
                }],
              }
            }
          }
          if (!specialistReportVersion) throw new Error('specialist_report_required')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await setStatus(
            specialistSessionId, specialistExecutionId,
            `execution:${specialistExecutionId}:status-failed`, 'failed',
            { error: message },
          )
          return {
            launched: true, status: 'failed', sessionId: specialistSessionId,
            executionId: specialistExecutionId,
            summary: `${config.label}专项失败`, keyFactIds: [], contraryFactIds: [],
            gaps: [{ capability: config.domain, reason: message, impact: '该专项无法形成报告' }],
          }
        }
        return {
          launched: true, status: specialistStatus, sessionId: specialistSessionId,
          executionId: specialistExecutionId, reportId: specialistReportVersion.id,
          reportVersion: specialistReportNumber!,
          ...specialistResultProjection(
            specialistReportVersion.report, config.request.researchQuestion,
          ),
        }
      }
      const runNewsSpecialist = async (request: SpecialistRequest) => {
        if (!options.model.analyzeNews || !options.searchNewsCandidates
          || !options.readNewsDocument || !options.listCompanyEvents) {
          throw new Error('news_specialist_runtime_unavailable')
        }
        return runSpecialistLifecycle({
          domain: 'news', label: '消息面', request,
          events: (
            specialistExecutionId, specialistRuntime, specialistActiveBudget,
            specialistWallDeadline,
          ) => options.model.analyzeNews!({
            executionId: specialistExecutionId, runtimeSettings, symbol: job.symbol,
            systemPrompt: '你是独立消息面 Agent。只使用新闻候选、新闻文档和公司事件工具；news 判断只能由 verified_news 或 official_company_event 支撑。报告的 supportingEvidence 与 contraryEvidence 数组只能逐字复制工具结果中的精确 fact.id，禁止填写标题、摘要、数值或自然语言证据描述；title_only 只能作为继续读取正文的线索，不能支撑判断。禁止个人买卖或仓位建议。',
            researchQuestion: request.researchQuestion,
            runtimeResume: specialistRecovery.get('news'), knownFacts: modelContext.facts,
            searchNewsCandidates: options.searchNewsCandidates!,
            searchWebEvidence: options.searchWebEvidence,
            readNewsDocument: options.readNewsDocument!,
            listCompanyEvents: options.listCompanyEvents!,
            signal: controller.signal, executionDeadlineSignal: specialistWallDeadline,
            activeBudget: specialistActiveBudget,
            acquireModelSlot: (signal) => modelGate.acquire(signal),
            acquireToolSlot: (signal) => toolGate.acquire(signal), toolRuntime: specialistRuntime,
          }),
        })
      }
      const runFundamentalSpecialist = async (request: SpecialistRequest) => {
        if (!options.model.analyzeFundamental || !options.getFinancialOverview
          || !options.getFinancialMetricSeries || !options.getValuationEvidence
          || !options.readFilingDocument
          || !options.listOfficialCompanyEvents) {
          throw new Error('fundamental_specialist_runtime_unavailable')
        }
        return runSpecialistLifecycle({
          domain: 'fundamental_valuation', label: '基本面', request,
          events: (
            specialistExecutionId, specialistRuntime, specialistActiveBudget,
            specialistWallDeadline,
          ) => options.model.analyzeFundamental!({
            executionId: specialistExecutionId, runtimeSettings, symbol: job.symbol,
            systemPrompt: '你是独立基本面 Agent。只使用财务概览、指标序列、Filing 和官方公司事件；fundamental 判断只能由 evidenceLevel 为 official_filing、reported_financial、deterministic_financial_metric 或 deterministic_valuation 的事实支撑，不得引用 verified_valuation_input 或 official_company_event 支撑判断。报告的 supportingEvidence 与 contraryEvidence 数组只能逐字复制工具结果中的精确 fact.id，禁止填写指标名、数值或自然语言证据描述；没有合格事实时省略该判断并写入 gaps。禁止个人买卖或仓位建议。',
            researchQuestion: request.researchQuestion,
            runtimeResume: specialistRecovery.get('fundamental_valuation'),
            knownFacts: modelContext.facts,
            getFinancialOverview: options.getFinancialOverview!,
            getFinancialMetricSeries: options.getFinancialMetricSeries!,
            getValuationEvidence: options.getValuationEvidence!,
            readFilingDocument: options.readFilingDocument!,
            listCompanyEvents: options.listOfficialCompanyEvents!,
            signal: controller.signal, executionDeadlineSignal: specialistWallDeadline,
            activeBudget: specialistActiveBudget,
            acquireModelSlot: (signal) => modelGate.acquire(signal),
            acquireToolSlot: (signal) => toolGate.acquire(signal), toolRuntime: specialistRuntime,
          }),
        })
      }
      const runTechnicalSpecialist = async (request: SpecialistRequest) => {
        if (!options.model.analyzeTechnical || !options.getTechnicalEvidence
          || !options.getPriceWindow) {
          throw new Error('technical_specialist_runtime_unavailable')
        }
        return runSpecialistLifecycle({
          domain: 'technical', label: '技术面', request,
          events: (
            specialistExecutionId, specialistRuntime, specialistActiveBudget,
            specialistWallDeadline,
          ) => options.model.analyzeTechnical!({
            executionId: specialistExecutionId, runtimeSettings, symbol: job.symbol,
            systemPrompt: '你是独立技术面 Agent。只使用宿主确定性技术证据和受控价格窗口；technical 判断的 supportingEvidence 与 contraryEvidence 都只能引用 evidenceLevel 为 deterministic_technical 的事实，不得引用 daily_bar、market_observation 或 indicators。两个数组只能逐字复制工具结果中的精确 fact.id，禁止填写指标名、数值或自然语言证据描述；技术专项报告必须省略 targetPrice。不得把模型上下文裁剪长度称为数据源总历史长度，不自行计算新指标；每项判断保留反方证据与失效条件，禁止个人买卖或仓位建议。',
            researchQuestion: request.researchQuestion,
            runtimeResume: specialistRecovery.get('technical'), knownFacts: modelContext.facts,
            getTechnicalEvidence: options.getTechnicalEvidence!,
            getPriceWindow: options.getPriceWindow!,
            signal: controller.signal, executionDeadlineSignal: specialistWallDeadline,
            activeBudget: specialistActiveBudget,
            acquireModelSlot: (signal) => modelGate.acquire(signal),
            acquireToolSlot: (signal) => toolGate.acquire(signal), toolRuntime: specialistRuntime,
          }),
        })
      }
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
        runtimeContext: followUpEvent ? undefined : runtimeContext,
        runtimeResume,
        runtimeFollowUp,
        priorSpecialistOutcomes,
        knownFacts: modelContext.facts,
        refreshKnownFacts,
        onSpecialistOutcome: rememberSpecialistOutcome,
        fetchFinancialContext: async () => modelContext,
        financialContextToolViews: { model: modelContext, retained: snapshot },
        prepareSpecialistBatch,
        signal: controller.signal,
        executionDeadlineSignal: wallDeadline,
        activeBudget,
        acquireModelSlot: (signal) => modelGate.acquire(signal),
        acquireToolSlot: (signal) => toolGate.acquire(signal),
        runNewsSpecialist: newsRuntimeAvailable ? runNewsSpecialist : undefined,
        runFundamentalSpecialist: fundamentalRuntimeAvailable ? runFundamentalSpecialist : undefined,
        runTechnicalSpecialist: technicalRuntimeAvailable ? runTechnicalSpecialist : undefined,
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
          if (['tool_result', 'compaction', 'context_usage'].includes(event.entry.type)
            && typeof event.entry.operationId === 'string') continue
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
        else if (event.type === 'chat_completed') {
          await appendTrace(sessionId, executionId, {
            type: 'chat_completed', text: event.text, usage: event.usage ?? null,
            stopReason: event.stopReason ?? null,
            operationId: event.operationId ?? nextModelOperationId('chat-completed'),
          })
          await setStatus(sessionId, executionId, operationId('status-completed'), 'completed')
          return
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
          const finalizedSnapshot = terminalSnapshot()
          const reportVersion = event.reportVersion
            ? finalReportVersion(
                executionId, event.reportVersion, report, status, gaps, finalizedSnapshot,
              ) : undefined
          await setStatus(sessionId, executionId, operationId(`status-${status}`), status, {
            report, snapshot: finalizedSnapshot, ...(reportVersion ? { reportVersion } : {}),
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
        if (followUpEvent && followUpEvent.updateReport !== true) {
          await setStatus(
            sessionId, executionId, operationId('budget-exhausted'), 'budget_exhausted',
            { error: 'follow_up_active_timeout' },
          )
          return
        }
        await setStatus(sessionId, executionId, operationId('budget-exhausted'), 'budget_exhausted', { terminal: false })
        await setStatus(sessionId, executionId, operationId('finalizing'), 'finalizing')
        const limitedContext = context ?? {
          symbol: job.symbol, facts: [], gaps: [{ capability: 'research_active', reason: 'budget_exhausted' }],
          indicators: {},
        }
        try {
          pauseProcessing()
          const finalizationBudget = createActiveBudget(
            runtimeSettings.modelRequestTimeoutMinutes * (options.runtimeMinuteMs ?? 60_000) * 2,
            options.activeNow,
            options.activeTimeoutSignal,
          )
          for await (const event of options.model.analyze({
            executionId, runtimeSettings, symbol: job.symbol,
            systemPrompt: ANALYSIS_SYSTEM_PROMPT,
            userPrompt: `研究 active time 已耗尽，请仅生成确定性受限报告。`,
            knownFacts: limitedContext.facts,
            refreshKnownFacts,
            finalizationOnly: true,
            priorSpecialistOutcomes: [...specialistOutcomes].map(([domain, outcome]) => ({
              domain, outcome,
            })),
            fetchFinancialContext: async () => limitedContext,
            signal: controller.signal, executionDeadlineSignal: wallDeadline,
            activeBudget: finalizationBudget,
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
              const finalizedSnapshot = terminalSnapshot()
              const reportVersion = event.reportVersion
                ? finalReportVersion(
                    executionId, event.reportVersion, report, 'partial', limitedContext.gaps ?? [],
                    finalizedSnapshot,
                  )
                : undefined
              await setStatus(sessionId, executionId, operationId('status-partial'), 'partial', {
                report, snapshot: finalizedSnapshot, ...(reportVersion ? { reportVersion } : {}),
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
  async function stopRuntimeTree(analysisId: string) {
    const inFlight = stoppingTasks.get(analysisId)
    if (inFlight) return inFlight
    let task: Promise<boolean>
    task = (async () => {
      const racedStates = new Map<string, Error>()
      while (true) {
        const job = await get(analysisId)
        if (!job) return false
        const sessions = await options.eventRepository.listSessions(analysisId)
        const activeSessions: AgentSession[] = []
        for (const session of sessions) {
          const lifecycle = await options.eventRepository.sessionLifecycle(session.id)
          if (lifecycle && !isTerminalAgentExecutionStatus(
            lifecycle.execution.status, lifecycle.execution.terminal,
          )) activeSessions.push({
            ...session, executionId: lifecycle.execution.id, status: lifecycle.execution.status,
          })
        }
        if (!activeSessions.length) return true
        const activeKey = activeSessions.map(({ id, executionId }) => `${id}:${executionId}`)
          .sort().join('|')
        const repeatedRace = racedStates.get(activeKey)
        if (repeatedRace) throw repeatedRace
        try {
          if (job.status === 'stopping') {
            controllers.get(analysisId)?.abort()
            await analysisTasks.get(analysisId)
            for (const session of activeSessions) await setStatus(
              session.id, session.executionId, `session:${session.id}:stopped`, 'stopped',
            )
            return true
          }
          const session = activeSessions.find(({ isPrimary }) => isPrimary) ?? activeSessions[0]
          if (!session) return false
          const fenceExecutionId = randomUUID()
          const createdAt = new Date().toISOString()
          const waitReason = waitReasonForStatus('stopping', '运行时停止确认', createdAt)
          const event = await options.eventRepository.fenceForStopping({
            sessionId: session.id, executionId: session.executionId, fenceExecutionId,
            operationId: `session:${session.id}:stopping`,
            event: {
              type: 'status', status: 'stopping', terminal: false,
              previousExecutionId: session.executionId, waitReason, at: createdAt,
            },
            createdAt,
          })
          for (const cancelled of event.cancelledToolEvents ?? []) {
            for (const listener of listeners.get(cancelled.sessionId) ?? []) listener(cancelled)
          }
          for (const fenced of event.fencedSessions ?? [event]) {
            for (const listener of listeners.get(fenced.sessionId) ?? []) listener(fenced)
          }
          controllers.get(analysisId)?.abort()
          await analysisTasks.get(analysisId)
          for (const fenced of event.fencedSessions ?? [{
            sessionId: session.id, executionId: fenceExecutionId,
          }]) {
            await setStatus(
              fenced.sessionId, fenced.executionId, `session:${fenced.sessionId}:stopped`, 'stopped',
            )
          }
          return true
        } catch (error) {
          if (!(error instanceof Error) || ![
            'agent_execution_terminal', 'agent_execution_fenced', 'agent_session_not_found',
          ].includes(error.message)) throw error
          racedStates.set(activeKey, error)
        }
      }
    })().finally(() => {
      if (stoppingTasks.get(analysisId) === task) stoppingTasks.delete(analysisId)
    })
    stoppingTasks.set(analysisId, task)
    return task
  }
  async function cancel(analysisId: string) {
    const job = await get(analysisId)
    if (!job || job.status === 'stopping'
      || isTerminalAgentExecutionStatus(job.status, job.terminal)) return false
    return stopRuntimeTree(analysisId)
  }
  async function resume(analysisId: string) {
    await initialized
    if (deletionTasks.has(analysisId)) throw new Error('analysis_deleting')
    const job = await repository.get(analysisId)
    if (!job || !['stopped', 'interrupted'].includes(job.status)) return null
    const lifecycle = await options.eventRepository.primaryLifecycle(analysisId)
    if (!lifecycle || !['stopped', 'interrupted'].includes(lifecycle.execution.status)) return null
    const executionId = randomUUID()
    const createdAt = new Date().toISOString()
    const generation = lifecycle.execution.generation + 1
    const stoppedSource = lifecycle.events.findLast((event) => {
      const payload = event as Record<string, unknown>
      return payload.status === 'stopping' && typeof payload.previousExecutionId === 'string'
    }) as (Record<string, unknown> | undefined)
    const sourceExecutionIds = job.status === 'stopped'
      && typeof stoppedSource?.previousExecutionId === 'string'
      ? [stoppedSource.previousExecutionId] : [lifecycle.execution.id]
    const sourceFollowUp = lifecycle.events.findLast((event) => {
      const payload = event as Record<string, unknown>
      return payload.type === 'runtime_follow_up'
        && payload.executionId === sourceExecutionIds[0]
    }) as (Record<string, unknown> | undefined)
    const result = await options.eventRepository.resumeResearch({
      analysisId, executionId, segmentId: randomUUID(),
      operationId: `execution:${executionId}:resumed`,
      event: {
        type: 'runtime_resume', status: 'planning', resumed: true,
        previousExecutionId: lifecycle.execution.id, executionId, generation,
        sourceExecutionIds,
        ...(sourceFollowUp ? { followUp: {
          messageId: sourceFollowUp.messageId,
          message: sourceFollowUp.message,
          updateReport: sourceFollowUp.updateReport === true,
          intent: sourceFollowUp.updateReport === true ? 'request_report_update' : 'chat',
          baseReportVersion: typeof sourceFollowUp.baseReportVersion === 'number'
            ? sourceFollowUp.baseReportVersion : null,
        } } : {}),
        waitReason: { kind: 'database', target: '恢复研究上下文', startedAt: createdAt },
        at: createdAt,
      },
      createdAt,
    })
    queueMicrotask(() => void schedule())
    return result
  }
  async function followUp(
    analysisId: string, messageIdInput: string, messageInput: string, updateReport = false,
    requestedBaseReportVersion?: number,
  ) {
    await initialized
    if (deletionTasks.has(analysisId)) throw new Error('analysis_deleting')
    const message = messageInput.trim()
    const messageId = messageIdInput.trim()
    if (!messageId || messageId.length > 200) throw new Error('follow_up_message_id_required')
    if (!message) throw new Error('follow_up_message_required')
    const record = await repository.get(analysisId)
    if (!record) return null
    const lifecycle = await options.eventRepository.primaryLifecycle(analysisId)
    if (!lifecycle) throw new Error('analysis_follow_up_not_available')
    const stableId = encodeURIComponent(messageId)
    const executionId = `analysis:${analysisId}:message:${stableId}`
    const operationId = `session:${lifecycle.id}:message:${stableId}`
    const replay = (await options.eventRepository.list(lifecycle.id, 0)).find(
      (event) => event.operationId === operationId,
    )
    const replayPayload = replay?.payload as Record<string, unknown> | undefined
    if (replayPayload && (replayPayload.messageId !== messageId
      || replayPayload.message !== message || replayPayload.updateReport !== updateReport
      || replayPayload.executionId !== executionId
      || (requestedBaseReportVersion !== undefined
        && replayPayload.baseReportVersion !== requestedBaseReportVersion))) {
      throw new Error('agent_operation_conflict')
    }
    const versions = replayPayload ? [] : await options.eventRepository.listReportVersions(analysisId)
    const integratedReports = versions.filter(({ sessionId, kind }) => (
      sessionId === lifecycle.id && kind === 'integrated'
    ))
    const baseReport = requestedBaseReportVersion === undefined
      ? integratedReports.at(-1)
      : integratedReports.find(({ version }) => version === requestedBaseReportVersion)
    if (!replayPayload && requestedBaseReportVersion !== undefined && !baseReport) {
      throw new Error('base_report_version_not_found')
    }
    const baseReportVersion = typeof replayPayload?.baseReportVersion === 'number'
      ? replayPayload.baseReportVersion : replayPayload ? null : baseReport?.version ?? null
    const intent = updateReport ? 'request_report_update' : 'chat'
    const event = replayPayload ?? {
      type: 'runtime_follow_up', status: 'planning', executionId,
      baseReportVersion, messageId, message, updateReport, intent,
    }
    const createdAt = new Date().toISOString()
    const result = await options.eventRepository.createFollowUpExecution({
      analysisId, executionId, segmentId: `${executionId}:segment`,
      baseReportVersion, operationId, event,
      createdAt,
    })
    queueMicrotask(() => void schedule())
    return { ...result, messageId, message, updateReport, intent }
  }
  async function research(analysisId: string) {
    await initialized
    const record = await repository.research(analysisId)
    if (!record) return null
    const session = await options.eventRepository.findPrimarySession(analysisId)
    const trace = session
      ? (await options.eventRepository.list(session.id, 0)).map(({ payload }) => payload)
      : []
    const specialistSessions = (await options.eventRepository.listSessions(analysisId))
      .filter(({ isPrimary }) => !isPrimary)
    const reportVersions = await options.eventRepository.listReportVersions(analysisId)
    const specialistAgents = await Promise.all(specialistSessions.map(async (specialist) => {
      const lifecycle = await options.eventRepository.sessionLifecycle(specialist.id)
      const events = lifecycle?.events as Array<Record<string, unknown>> | undefined
      const created = events?.filter((event) => event.type === 'specialist_context').at(-1)
      const reportVersion = reportVersions.filter(({ sessionId }) => sessionId === specialist.id).at(-1)
      return lifecycle ? {
        ...lifecycle, domain: created?.domain ?? 'unknown',
        researchQuestion: created?.researchQuestion, reason: created?.reason,
        ...(reportVersion ? { reportVersion } : {}),
      } : null
    }))
    const specialistDecision = (toolName: string) => trace.find((event) => {
      if (event.type !== 'tool_result' || event.name !== toolName) return false
      const result = event.result as Record<string, unknown> | undefined
      return result?.launched === false
    })
    const newsDecision = specialistDecision('run_news_analysis')
    const newsResult = newsDecision?.result as Record<string, unknown> | undefined
    const projectedSpecialists: Array<Record<string, unknown>> = specialistAgents.filter(
      (specialist): specialist is NonNullable<typeof specialist> => specialist !== null,
    )
    if (!projectedSpecialists.some((specialist) => specialist?.domain === 'news')) {
      projectedSpecialists.push(newsResult ? {
        domain: 'news', status: 'not_started',
        researchQuestion: newsResult.researchQuestion, reason: newsResult.reason,
      } : {
        domain: 'news', status: 'not_started',
        reason: '主 Agent 尚未作出消息面专项启动决定。',
      })
    }
    const fundamentalDecision = specialistDecision('run_fundamental_analysis')
    const fundamentalResult = fundamentalDecision?.result as Record<string, unknown> | undefined
    if (!projectedSpecialists.some((specialist) => specialist?.domain === 'fundamental_valuation')) {
      projectedSpecialists.push(fundamentalResult ? {
        domain: 'fundamental_valuation', status: 'not_started',
        researchQuestion: fundamentalResult.researchQuestion, reason: fundamentalResult.reason,
      } : {
        domain: 'fundamental_valuation', status: 'not_started',
        reason: '主 Agent 尚未作出基本面专项启动决定。',
      })
    }
    const technicalDecision = specialistDecision('run_technical_analysis')
    const technicalResult = technicalDecision?.result as Record<string, unknown> | undefined
    if (!projectedSpecialists.some((specialist) => specialist?.domain === 'technical')) {
      projectedSpecialists.push(technicalResult ? {
        domain: 'technical', status: 'not_started',
        researchQuestion: technicalResult.researchQuestion, reason: technicalResult.reason,
      } : {
        domain: 'technical', status: 'not_started',
        reason: '主 Agent 尚未作出技术面专项启动决定。',
      })
    }
    return {
      ...record, trace,
      mainAgent: await options.eventRepository.primaryLifecycle(analysisId),
      specialistAgents: projectedSpecialists,
      reportVersions: reportVersions.filter(({ sessionId, kind }) => (
        sessionId === session?.id && kind === 'integrated'
      )).map(({ snapshot: _snapshot, ...version }) => version),
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
    const inFlight = deletionTasks.get(analysisId)
    if (inFlight) return inFlight
    let task: Promise<boolean>
    task = (async () => {
      await initialized
      const job = await repository.get(analysisId)
      if (!job) return false
      if (!isTerminalAgentExecutionStatus(job.status, job.terminal)
        && !await stopRuntimeTree(analysisId)) return false
      try {
        return await repository.removeResearch(analysisId)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'analysis_not_stopped') throw error
        if (!await stopRuntimeTree(analysisId)) return false
        return repository.removeResearch(analysisId)
      }
    })().finally(() => {
      if (deletionTasks.get(analysisId) === task) deletionTasks.delete(analysisId)
    })
    deletionTasks.set(analysisId, task)
    return task
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
  return {
    create, get, cancel, resume, followUp, research, listResearch, updateResearch, removeResearch,
    streamEvents, close, updateRuntimePolicy,
  }
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
你可以自主规划分析路径。建议先确认本次冻结的金融上下文；按需调用 fetch_financial_context。需要深入解释正式财务事实、消息面或多周期技术结构时，必须分别通过 run_fundamental_analysis、run_news_analysis、run_technical_analysis 明确决定是否启动独立专项 Agent。专项 Agent 只接收本领域受控工具，主 Agent 最终必须调用 submit_analysis_report 提交报告。
不得编造行情、新闻、财报、估值或持仓；所有事实判断只能引用工具结果中真实存在的事实 ID。
每条 keyJudgments 都必须关联一个或多个事实 ID；supportingEvidence 和 contraryEvidence 也必须引用事实 ID。
证据资格必须逐条匹配：market 只能引用 market_observation 或 verified_market；news 只能引用 verified_news 或 official_company_event；fundamental 只能引用 official_filing、reported_financial、deterministic_financial_metric 或 deterministic_valuation；technical 只能引用 deterministic_technical；operational 只能引用 runtime_observation。supportingEvidence 与 contraryEvidence 数组只能逐字复制工具结果中的精确 fact.id，禁止填写标题、指标名、数值或自然语言证据描述；没有合格事实时删除该判断并把缺口写入 gaps，不能用不合格证据硬凑。
财报增长率、利润率、TTM、自由现金流、质量标记、技术指标与估值结果由宿主程序计算，你只负责解释，不重新计算或改写输入数字。
必须区分“当前估值倍数”和“目标价估值方法”：目标价方法不可用不等于当前 PE 等倍数不可用。
只有存在 unit 为 USD/share 且 status 为 available 的 deterministic_valuation 事实时才能填写 targetPrice；从同一个事实的 value 中将 method、inputs、range、asOf 原样复制，evidence 数组只能填写该 deterministic_valuation 的精确 fact.id。不得改写 method、不得把估值事实 ID 塞进 inputs、不得把输入事实 ID 塞进 evidence；不能逐字段原样复制时必须省略 targetPrice。
模型上下文中的日线是冻结快照的裁剪样本，不得据此声称数据源只有这些交易日；以 contextScope 中的数量说明裁剪范围。
数据不足时明确写入 limitations；缺行情不得判断走势，缺财报或估值输入不得给目标价，缺新闻不得推断新闻驱动。
追问同时提供 reportPositionContext 和 currentPositionSummary 时，必须区分报告时的历史判断与当前持仓影响。
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
  snapshot?: unknown,
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
    ...(snapshot !== undefined ? { snapshot } : {}),
  }
}

function latestCompactionSummary(lifecycle: unknown) {
  const compactions = (lifecycle as {
    compactions?: Array<{ summary?: Record<string, unknown> }>
  } | null | undefined)?.compactions
  const summary = compactions?.at(-1)?.summary
  return summary ? { compactionSummary: summary } : {}
}

function specialistResultProjection(report: Record<string, unknown>, fallbackSummary: string) {
  const judgments = Array.isArray(report.keyJudgments)
    ? report.keyJudgments.filter((item): item is Record<string, unknown> => Boolean(item)
      && typeof item === 'object' && !Array.isArray(item)) : []
  const keyFactIds = judgments.flatMap((judgment) => Array.isArray(judgment.supportingEvidence)
    ? judgment.supportingEvidence.filter((id): id is string => typeof id === 'string') : [])
  const contraryFactIds = judgments.flatMap((judgment) => Array.isArray(judgment.contraryEvidence)
    ? judgment.contraryEvidence.filter((id): id is string => typeof id === 'string') : [])
  const firstStatement = judgments.find(({ statement }) => typeof statement === 'string')?.statement
  return {
    summary: typeof firstStatement === 'string' ? firstStatement : fallbackSummary,
    keyFactIds: [...new Set(keyFactIds)], contraryFactIds: [...new Set(contraryFactIds)],
    gaps: Array.isArray(report.gaps) ? report.gaps : [],
    ...('targetPrice' in report ? { targetPrice: report.targetPrice } : {}),
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

type ToolReplay = Awaited<ReturnType<ToolProjectionRepository['replay']>>

function reusableResults(
  runtimes: ToolReplay[], knownFactIds: Set<string>, facts: Fact[],
  role: 'main' | 'fundamental' | 'news' | 'technical', currentToolNames: string[],
) {
  const factsById = new Map(facts.map((fact) => [fact.id, fact]))
  return runtimes.flatMap((runtime) => runtime.toolBatches.flatMap((batch) => {
    const projection = runtime.projections.find(({ version }) => version === batch.projectionVersion)
    return batch.results.flatMap((result) => {
      const payload = result.resultPayload as {
        toolName?: unknown; result?: { facts?: Array<{ id?: unknown }> }; isError?: unknown
      } | null
      const toolName = typeof payload?.toolName === 'string' ? payload.toolName : ''
      const definition = toolName ? toolRegistry.definition(toolName) : undefined
      if (result.status !== 'completed' || payload?.isError !== false || !definition
        || !definition.allowedRoles.includes(role) || !currentToolNames.includes(toolName)
        || !projection?.visibleToolNames.includes(toolName)
        || !projection.projectedTools.some((projected) => (
          JSON.stringify(projected) === JSON.stringify(definition.model)
        ))) return []
      const factIds = Array.isArray(payload.result?.facts) ? payload.result.facts.flatMap((item) => {
        if (typeof item.id !== 'string' || !knownFactIds.has(item.id)) return []
        const fact = factsById.get(item.id)
        return fact && validReusableFact(fact) ? [item.id] : []
      }) : []
      if (!factIds.length) return []
      const factSet = new Set(factIds)
      return [{
        toolName, factIds,
        modelProjection: toolRegistry.projectResult(toolName, {
          ...payload.result,
          facts: facts.filter(({ id }) => factSet.has(id)),
        }),
      }]
    })
  }))
}

function validReusableFact(fact: Fact) {
  if (!fact.id || !fact.type || !fact.source || !fact.sourceReference) return false
  if (!Number.isFinite(Date.parse(fact.observedAt)) || !Number.isFinite(Date.parse(fact.fetchedAt))) {
    return false
  }
  const level = fact.evidenceLevel
    ?? (['quote', 'daily_bar'].includes(fact.type) ? 'market_observation' : undefined)
  if (fact.type === 'quote') {
    return Date.now() - Date.parse(fact.observedAt) <= 24 * 60 * 60 * 1000
  }
  return typeof level === 'string'
}

function unresolvedResults(runtimes: ToolReplay[]) {
  return runtimes.flatMap((runtime) => runtime.toolBatches.flatMap((batch) => (
    batch.results.length ? batch.results.flatMap((result) => (
      result.status === 'completed' ? [] : [{
        kind: 'tool_call', id: result.toolCallId, status: result.status,
      }]
    )) : [{ kind: 'tool_batch', id: batch.id, status: batch.status }]
  )))
}

function specialistToolNames(domain: SpecialistDomain) {
  if (domain === 'news') return [
    ...newsSpecialistTools.map(({ name }) => name), 'search_web_evidence',
  ]
  if (domain === 'fundamental_valuation') return financialSpecialistTools.map(({ name }) => name)
  return technicalSpecialistTools.map(({ name }) => name)
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
