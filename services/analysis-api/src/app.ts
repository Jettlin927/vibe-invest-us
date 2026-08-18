import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import {
  defaultRuntimeSettings, formatSseEvent, parseRuntimeSettingsUpdate, type FinancialDataHealth,
} from '@vibe-invest/contracts'
import type {
  AgentEventRepository, AnalysisRepository, PortfolioRepository, RuntimeSettingsRepository,
  ToolProjectionRepository,
} from '@vibe-invest/product-dao'

import { createAnalysisService } from './analysis.js'
import type { ModelEvent } from './model.js'
import {
  MARKET_PRICE_REQUEST_TIMEOUT_MS,
  type FactQueryResult, type FinancialContext, type PaginatedFactQueryResult,
} from './financial-data-client.js'
import { createPortfolio, isValidSymbol, normalizeSymbol } from './portfolio.js'
import { projectResearchExport, projectResearchView } from './research-export.js'

type AppDependencies = {
  productDatabase: {
    checkSchema: () => Promise<{ status: 'ok'; version: number }>
    close: () => Promise<void>
  }
  portfolioRepository: PortfolioRepository
  analysisRepository: AnalysisRepository
  agentEventRepository: AgentEventRepository
  runtimeSettingsRepository: RuntimeSettingsRepository
  toolProjectionRepository: ToolProjectionRepository
  financialDataHealth: () => Promise<FinancialDataHealth>
  staticDir?: string
  fetchFinancialContext?: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchNewsCandidates?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchWebEvidence?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  readNewsDocument?: (
    candidate: import('./financial-data-client.js').FinancialFact, signal: AbortSignal,
  ) => Promise<FactQueryResult>
  listCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  listOfficialCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  getFinancialOverview?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('./financial-data-client.js').FinancialFact[]; overview: Record<string, unknown>; sources?: unknown[] }>
  getFinancialMetricSeries?: (
    symbol: string, metric: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  getValuationEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('./financial-data-client.js').FinancialFact[]; [key: string]: unknown }>
  getTechnicalEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('./financial-data-client.js').FinancialFact[]; [key: string]: unknown }>
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
  marketPriceTimeoutMs?: number
  model?: {
    analyze(input: any): AsyncIterable<ModelEvent>
    analyzeNews?: (input: any) => AsyncIterable<ModelEvent>
    analyzeFundamental?: (input: any) => AsyncIterable<ModelEvent>
    analyzeTechnical?: (input: any) => AsyncIterable<ModelEvent>
  }
  modelConfigured?: boolean
  now?: () => Date
  runtimeMinuteMs?: number
  activeNow?: () => number
  activeTimeoutSignal?: (timeoutMs: number) => AbortSignal
  migrationVerificationToken?: string
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false })
  const portfolio = createPortfolio(dependencies.portfolioRepository)
  const lifecycleOnly = dependencies.modelConfigured === false
    || !dependencies.fetchFinancialContext || !dependencies.model
  const analysis = createAnalysisService({
        repository: dependencies.analysisRepository,
        eventRepository: dependencies.agentEventRepository,
        settingsRepository: dependencies.runtimeSettingsRepository,
        toolProjectionRepository: dependencies.toolProjectionRepository,
        fetchFinancialContext: dependencies.fetchFinancialContext
          ?? (async () => { throw new Error('model_not_configured') }),
        searchNews: dependencies.searchNews,
        searchNewsCandidates: dependencies.searchNewsCandidates,
        searchWebEvidence: dependencies.searchWebEvidence,
        readNewsDocument: dependencies.readNewsDocument,
        listCompanyEvents: dependencies.listCompanyEvents,
        listOfficialCompanyEvents: dependencies.listOfficialCompanyEvents,
        getFinancialOverview: dependencies.getFinancialOverview,
        getFinancialMetricSeries: dependencies.getFinancialMetricSeries,
        getValuationEvidence: dependencies.getValuationEvidence,
        getTechnicalEvidence: dependencies.getTechnicalEvidence,
        getPriceWindow: dependencies.getPriceWindow,
        readFilingDocument: dependencies.readFilingDocument,
        fetchTechnicalIndicators: dependencies.fetchTechnicalIndicators,
        fetchMarketPrices: dependencies.fetchMarketPrices,
        listPortfolioSymbols: async () => (await portfolio.list()).map((position) => position.symbol),
        model: dependencies.model ?? { async *analyze() {} },
        getPortfolioContext: (symbol, marketPrices) => portfolio.context(symbol, marketPrices),
        runtimeMinuteMs: dependencies.runtimeMinuteMs,
        activeNow: dependencies.activeNow,
        activeTimeoutSignal: dependencies.activeTimeoutSignal,
        runEnabled: !lifecycleOnly,
      })

  app.addHook('onClose', async () => {
    await analysis?.close()
    await dependencies.productDatabase.close()
  })

  if (dependencies.staticDir) {
    void app.register(fastifyStatic, {
      root: dependencies.staticDir,
    })
  }

  app.get('/api/health', async (_request, reply) => {
    try {
      const productDatabase = await dependencies.productDatabase.checkSchema()
      const financialData = await dependencies.financialDataHealth()

      return {
        service: 'analysis-api',
        status: 'ok',
        dependencies: {
          productDatabase: {
            status: productDatabase.status,
            engine: 'postgresql',
            schemaVersion: productDatabase.version,
          },
          financialData,
        },
      }
    } catch {
      return reply.status(503).send({
        service: 'analysis-api',
        status: 'unavailable',
      })
    }
  })

  app.get('/api/positions', async () => ({ positions: await portfolio.list() }))

  app.get('/api/migration-verification', async (request, reply) => {
    const token = dependencies.migrationVerificationToken
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.status(404).send({ error: 'not_found' })
    }
    return dependencies.portfolioRepository.migrationVerificationState()
  })

  app.get('/api/portfolio', async (_request, reply) => {
    const positions = await portfolio.list()
    if (!positions.length) return portfolio.overview({})
    if (!dependencies.fetchMarketPrices) return portfolio.overview({})
    try {
      const prices = await dependencies.fetchMarketPrices(
        positions.map((position) => position.symbol),
        AbortSignal.timeout(dependencies.marketPriceTimeoutMs ?? MARKET_PRICE_REQUEST_TIMEOUT_MS),
      )
      const overview = await portfolio.overview(prices)
      await portfolio.recordSnapshot(overview, dependencies.now?.() ?? new Date())
      return overview
    } catch {
      return reply.status(200).send(await portfolio.overview({}))
    }
  })

  app.get<{ Querystring: { limit?: string } }>('/api/portfolio/history', async (request) => ({
    currency: 'USD',
    snapshots: await portfolio.history(Number(request.query.limit ?? 30)),
  }))

  app.put<{ Body: { cash?: unknown } }>('/api/portfolio/cash', async (request, reply) => {
    const cash = request.body?.cash
    if (typeof cash !== 'number' || !Number.isFinite(cash) || cash < 0) {
      return reply.status(400).send({ error: 'invalid_cash' })
    }
    return { cash: await portfolio.setCash(cash) }
  })

  app.get('/api/settings', async () => ({
    model: { configured: dependencies.modelConfigured ?? Boolean(dependencies.model) },
    current: await dependencies.runtimeSettingsRepository.current(),
    defaults: defaultRuntimeSettings,
    activeExecutions: await dependencies.runtimeSettingsRepository.listActiveExecutionSnapshots(),
  }))

  app.put<{ Body: unknown }>('/api/settings', async (request, reply) => {
    let update
    try {
      update = parseRuntimeSettingsUpdate(request.body)
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'invalid_runtime_settings_update' })
    }
    const revision = await dependencies.runtimeSettingsRepository.save(
      update, (dependencies.now?.() ?? new Date()).toISOString(),
    )
    analysis?.updateRuntimePolicy(revision.values)
    return revision
  })

  app.post('/api/settings/defaults', async () => {
    const revision = await dependencies.runtimeSettingsRepository.restoreDefaults(
      (dependencies.now?.() ?? new Date()).toISOString(),
    )
    analysis?.updateRuntimePolicy(revision.values)
    return revision
  })

  app.put<{ Params: { symbol: string }; Body: { quantity?: unknown; averageCost?: unknown } }>(
    '/api/positions/:symbol',
    async (request, reply) => {
      const symbol = normalizeSymbol(request.params.symbol)
      const { quantity, averageCost } = request.body ?? {}
      if (
        !isValidSymbol(symbol)
        || typeof quantity !== 'number'
        || !Number.isFinite(quantity)
        || quantity <= 0
        || typeof averageCost !== 'number'
        || !Number.isFinite(averageCost)
        || averageCost < 0
      ) {
        return reply.status(400).send({ error: 'invalid_position' })
      }
      return portfolio.save({ symbol, quantity, averageCost })
    },
  )

  app.delete<{ Params: { symbol: string } }>('/api/positions/:symbol', async (request, reply) => {
    const symbol = normalizeSymbol(request.params.symbol)
    if (!isValidSymbol(symbol)) return reply.status(400).send({ error: 'invalid_symbol' })
    await portfolio.remove(symbol)
    return reply.status(204).send()
  })

  app.post<{
    Params: { symbol: string }
    Body: { quantity?: unknown; price?: unknown }
  }>('/api/positions/:symbol/reduce', async (request, reply) => {
    const symbol = normalizeSymbol(request.params.symbol)
    const { quantity, price } = request.body ?? {}
    if (
      !isValidSymbol(symbol)
      || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0
      || typeof price !== 'number' || !Number.isFinite(price) || price < 0
    ) return reply.status(400).send({ error: 'invalid_reduction' })
    const result = await portfolio.reduce(symbol, quantity, price)
    return result ?? reply.status(400).send({ error: 'reduction_exceeds_position' })
  })

  app.post<{
    Body: { symbol?: unknown; marketPrices?: unknown }
  }>('/api/portfolio-context', async (request, reply) => {
    const symbol = typeof request.body?.symbol === 'string'
      ? normalizeSymbol(request.body.symbol)
      : ''
    const prices = request.body?.marketPrices
    if (!isValidSymbol(symbol) || !prices || typeof prices !== 'object' || Array.isArray(prices)) {
      return reply.status(400).send({ error: 'invalid_portfolio_context' })
    }
    return portfolio.context(symbol, prices as Record<string, number>)
  })

  app.post<{ Body: { symbol?: unknown } }>('/api/analyses', async (request, reply) => {
    if (!analysis || typeof request.body?.symbol !== 'string') return reply.status(400).send({ error: 'invalid_analysis' })
    const symbol = normalizeSymbol(request.body.symbol)
    if (!isValidSymbol(symbol)) return reply.status(400).send({ error: 'invalid_symbol' })
    const result = await analysis.create(symbol)
    return reply.status(202).send(result)
  })
  app.get<{ Params: { id: string } }>('/api/analyses/:id', async (request, reply) => {
    const result = await analysis?.get(request.params.id)
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'analysis_not_found' })
  })
  app.get<{ Params: { id: string }; Querystring: { executionId?: string } }>(
    '/api/agent-sessions/:id/tool-runtime', async (request, reply) => {
    const session = await dependencies.agentEventRepository.getSession(request.params.id)
    if (!session) return reply.status(404).send({ error: 'agent_session_not_found' })
    const executionId = request.query.executionId ?? session.executionId
    const runtime = await dependencies.toolProjectionRepository.replayForSession(
      session.id, executionId,
    )
    return runtime
      ? projectResearchView(runtime)
      : reply.status(404).send({ error: 'agent_execution_not_found' })
  })
  app.get<{ Params: { id: string }; Headers: { 'last-event-id'?: string } }>(
    '/api/agent-sessions/:id/events', async (request, reply) => {
    const currentAnalysis = analysis
    if (!currentAnalysis || !await dependencies.agentEventRepository.getSession(request.params.id)) {
      return reply.status(404).send({ error: 'agent_session_not_found' })
    }
    const cursor = parseLastEventId(request.headers['last-event-id'], request.params.id)
    if (cursor === null) return reply.status(400).send({ error: 'invalid_last_event_id' })
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const controller = new AbortController()
    request.raw.on('close', () => controller.abort())
    for await (const entry of currentAnalysis.streamEvents(
      request.params.id, cursor, controller.signal,
    )) {
      const payload = entry.payload
      const event = payload.type === 'status' ? payload.status : payload.type
      reply.raw.write(formatSseEvent({
        id: `${entry.sessionId}:${entry.sequence}`, event: String(event),
        data: projectResearchView(payload),
      }))
    }
    reply.raw.end()
  })
  app.post<{ Params: { id: string } }>('/api/analyses/:id/cancel', async (request, reply) => {
    if (!await analysis?.cancel(request.params.id)) return reply.status(409).send({ error: 'analysis_not_cancellable' })
    return reply.status(202).send({ status: 'cancelling' })
  })
  app.post<{ Params: { id: string } }>('/api/analyses/:id/resume', async (request, reply) => {
    try {
      const resumed = await analysis?.resume(request.params.id)
      if (!resumed) return reply.status(409).send({ error: 'analysis_not_resumable' })
      return reply.status(202).send(resumed)
    } catch (error) {
      if (error instanceof Error && ['analysis_not_resumable', 'analysis_deleting']
        .includes(error.message)) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })
  app.post<{
    Params: { id: string }
    Body: {
      messageId?: unknown; message?: unknown; updateReport?: unknown
      baseReportVersion?: unknown
    }
  }>('/api/analyses/:id/messages', async (request, reply) => {
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return reply.status(400).send({ error: 'follow_up_message_required' })
    }
    if (typeof request.body?.messageId !== 'string' || !request.body.messageId.trim()
      || request.body.messageId.length > 200) {
      return reply.status(400).send({ error: 'follow_up_message_id_required' })
    }
    if (request.body.updateReport !== undefined && typeof request.body.updateReport !== 'boolean') {
      return reply.status(400).send({ error: 'follow_up_update_report_invalid' })
    }
    if (request.body.baseReportVersion !== undefined
      && (!Number.isInteger(request.body.baseReportVersion)
        || Number(request.body.baseReportVersion) <= 0)) {
      return reply.status(400).send({ error: 'follow_up_base_report_version_invalid' })
    }
    try {
      const result = await analysis?.followUp(
        request.params.id, request.body.messageId, request.body.message,
        request.body.updateReport ?? false,
        request.body.baseReportVersion as number | undefined,
      )
      if (!result) return reply.status(404).send({ error: 'analysis_not_found' })
      return reply.status(202).send(result)
    } catch (error) {
      if (error instanceof Error && [
        'analysis_follow_up_not_available', 'agent_operation_conflict',
        'base_report_version_not_found', 'analysis_resume_required', 'analysis_deleting',
      ].includes(error.message)) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })
  app.get<{ Params: { id: string } }>('/api/research/:id', async (request, reply) => {
    const result = await analysis?.research(request.params.id)
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'research_not_found' })
  })
  app.get<{ Params: { id: string } }>('/api/research/:id/export', async (request, reply) => {
    const result = await analysis?.research(request.params.id)
    if (!result) return reply.status(404).send({ error: 'research_not_found' })
    const configurationVersions = (await Promise.all(
      researchExecutionIds(result).map((executionId) => (
        dependencies.runtimeSettingsRepository.getExecutionSnapshot(executionId)
      )),
    )).filter((snapshot) => snapshot !== null)
    reply.header('content-disposition', 'attachment; filename="research.json"')
    return projectResearchExport({ ...result, configurationVersions })
  })
  app.get<{ Params: { id: string } }>('/api/research/:id/report-versions', async (request, reply) => {
    if (!await dependencies.analysisRepository.get(request.params.id)) {
      return reply.status(404).send({ error: 'analysis_not_found' })
    }
    return projectResearchView({
      items: (await dependencies.agentEventRepository.listReportVersions(request.params.id))
        .map(({ snapshot: _snapshot, ...version }) => version),
    })
  })
  app.get<{ Querystring: { symbol?: string } }>('/api/research', async (request) => (
    projectResearchView({ records: await analysis?.listResearch(request.query.symbol) ?? [] })
  ))
  app.patch<{
    Params: { id: string }
    Body: { starred?: unknown; note?: unknown }
  }>('/api/research/:id', async (request, reply) => {
    const { starred, note } = request.body ?? {}
    if ((starred !== undefined && typeof starred !== 'boolean') || (note !== undefined && typeof note !== 'string')) {
      return reply.status(400).send({ error: 'invalid_research_update' })
    }
    const result = await analysis?.updateResearch(request.params.id, { starred, note })
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'research_not_found' })
  })
  app.delete<{ Params: { id: string } }>('/api/research/:id', async (request, reply) => {
    if (!await analysis?.removeResearch(request.params.id)) return reply.status(404).send({ error: 'research_not_found' })
    return reply.status(204).send()
  })

  return app
}

function parseLastEventId(value: string | undefined, sessionId: string) {
  if (value === undefined) return 0
  const match = value.match(/^(.+):(0|[1-9]\d*)$/)
  if (!match || match[1] !== sessionId) return null
  const sequence = Number(match[2])
  return Number.isSafeInteger(sequence) ? sequence : null
}

function researchExecutionIds(value: unknown) {
  const research = asRecord(value)
  const mainAgent = asRecord(research.mainAgent)
  const specialistAgents = Array.isArray(research.specialistAgents) ? research.specialistAgents : []
  const reportVersions = Array.isArray(research.reportVersions) ? research.reportVersions : []
  const ids = [
    asRecord(mainAgent.execution).id,
    ...specialistAgents.flatMap((agent) => {
      const candidate = asRecord(agent)
      return [asRecord(candidate.execution).id, asRecord(candidate.reportVersion).executionId]
    }),
    ...reportVersions.map((version) => asRecord(version).executionId),
  ].filter((id): id is string => typeof id === 'string' && Boolean(id))
  return [...new Set(ids)]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
