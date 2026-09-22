import { createWorkbenchToolExecutor } from './workbench-tools.js'
import { createWorkbench } from './workbench.js'
import { createResearchLibrary } from './research-library.js'
import type { WorkbenchRepository, ResearchLibraryRepository } from '@vibe-invest/db'

import {
  defaultRuntimeSettings, parseRuntimeSettingsUpdate, type FinancialDataHealth,
} from '@vibe-invest/contracts'
import type {
  AgentEventRepository, AnalysisRepository, ConversationRepository, PortfolioRepository,
  ProfitProtectionRepository, RuntimeSettingsRepository, ToolProjectionRepository, TrackingRepository,
} from '@vibe-invest/db'

import { createAnalysisService } from './analysis.js'
import { createConversationService } from './conversation.js'
import type { ModelEvent } from './agent-runtime/model.js'
import {
  MARKET_PRICE_REQUEST_TIMEOUT_MS,
  type FactQueryResult, type FinancialContext, type PaginatedFactQueryResult, type QuoteSnapshot,
} from '../adapters/financial-data-client.js'
import { createPortfolio } from './portfolio.js'
import { pricesFromSnapshots, type QuoteBatch } from './quote-cache.js'
import { createProfitProtection } from './profit-protection.js'
import { projectResearchExport, projectResearchView } from './research-export.js'
import { createResearchToolExecutor } from './research-capability.js'
import { conversationConditionalTools, conversationResearchTools } from './tools.js'
import { createTrackingService } from './tracking.js'

export type ApplicationDependencies = {
  productDatabase: {
    checkSchema: () => Promise<{ status: 'ok'; version: number }>
    close: () => Promise<void>
  }
  workbenchRepository?: WorkbenchRepository
  researchLibraryRepository?: ResearchLibraryRepository
  portfolioRepository: PortfolioRepository
  profitProtectionRepository?: ProfitProtectionRepository
  analysisRepository: AnalysisRepository
  agentEventRepository: AgentEventRepository
  runtimeSettingsRepository: RuntimeSettingsRepository
  toolProjectionRepository: ToolProjectionRepository
  conversationRepository?: ConversationRepository
  trackingRepository?: TrackingRepository
  financialDataHealth: () => Promise<FinancialDataHealth>
  fetchFinancialContext?: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchNewsCandidates?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  searchWebEvidence?: (query: string, signal: AbortSignal) => Promise<FactQueryResult>
  readNewsDocument?: (
    candidate: import('../adapters/financial-data-client.js').FinancialFact, signal: AbortSignal,
  ) => Promise<FactQueryResult>
  listCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  listOfficialCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  getFinancialOverview?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('../adapters/financial-data-client.js').FinancialFact[]; overview: Record<string, unknown>; sources?: unknown[] }>
  getFinancialMetricSeries?: (
    symbol: string, metric: string, cursor: string | undefined, signal: AbortSignal,
  ) => Promise<PaginatedFactQueryResult>
  getValuationEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('../adapters/financial-data-client.js').FinancialFact[];[key: string]: unknown }>
  getTechnicalEvidence?: (
    symbol: string, signal: AbortSignal,
  ) => Promise<{ facts: import('../adapters/financial-data-client.js').FinancialFact[];[key: string]: unknown }>
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
  fetchMarketQuotes?: (
    symbols: string[], signal: AbortSignal, options?: { force?: boolean },
  ) => Promise<QuoteBatch>
  fetchTrackingQuotes?: (symbols: string[], signal: AbortSignal) => Promise<QuoteSnapshot[]>
  trackingConcurrency?: number
  trackingScanIntervalMs?: number
  trackingBackgroundError?: (error: unknown) => void
  marketPriceTimeoutMs?: number
  model?: {
    analyze(input: any): AsyncIterable<ModelEvent>
    analyzeConversation?: (input: any) => AsyncIterable<ModelEvent>
    analyzeNews?: (input: any) => AsyncIterable<ModelEvent>
    analyzeFundamental?: (input: any) => AsyncIterable<ModelEvent>
    analyzeTechnical?: (input: any) => AsyncIterable<ModelEvent>
  }
  modelConfigured?: boolean
  now?: () => Date
  runtimeMinuteMs?: number
  activeNow?: () => number
  activeTimeoutSignal?: (timeoutMs: number) => AbortSignal
}

function nestedNumber(value: unknown, ...path: string[]) {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null
}

function quoteFreshness(batch: QuoteBatch) {
  const observed = batch.snapshots
    .flatMap((quote) => (typeof quote.observedAt === 'string' ? [quote.observedAt] : []))
    .sort()
  return {
    // 取最早的一个：整批行情至少新到这个时间，避免用最新的一支掩盖滞后的持仓。
    observedAt: observed[0] ?? null,
    sources: [...new Set(batch.snapshots.flatMap((quote) => (quote.source ? [quote.source] : [])))].sort(),
    fetchedAt: new Date(batch.fetchedAt).toISOString(),
    cached: batch.cached,
  }
}

export function createApplicationServices(dependencies: ApplicationDependencies) {
  const workbench = dependencies.workbenchRepository ? createWorkbench(dependencies.workbenchRepository) : undefined
  const library = dependencies.researchLibraryRepository ? createResearchLibrary({ repository: dependencies.researchLibraryRepository }) : undefined
  const portfolio = createPortfolio(dependencies.portfolioRepository)
  const profitProtection = dependencies.profitProtectionRepository
    ? createProfitProtection(dependencies.profitProtectionRepository)
    : undefined
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
    model: dependencies.model ?? { async *analyze() { } },
    getPortfolioContext: (symbol, marketPrices) => portfolio.context(symbol, marketPrices),
    runtimeMinuteMs: dependencies.runtimeMinuteMs,
    activeNow: dependencies.activeNow,
    activeTimeoutSignal: dependencies.activeTimeoutSignal,
    runEnabled: !lifecycleOnly,
  })
  const conversation = dependencies.conversationRepository && dependencies.model?.analyzeConversation
    ? createConversationService({
      repository: dependencies.conversationRepository,
      eventRepository: dependencies.agentEventRepository,
      settingsRepository: dependencies.runtimeSettingsRepository,
      toolProjectionRepository: dependencies.toolProjectionRepository,
      tools: conversationResearchTools,
      conditionalTools: dependencies.searchWebEvidence ? conversationConditionalTools : [],
      model: { analyzeConversation: dependencies.model.analyzeConversation },
      createToolExecutor: ({ threadId, executionId, scopeMessages, userMessage, knownFacts, symbols }) => createWorkbenchToolExecutor({
        library, workbench, portfolio: dependencies.portfolioRepository, tracking: dependencies.trackingRepository,
        conversations: dependencies.conversationRepository!,
      }, { threadId, executionId, scopeMessages, userMessage, knownFacts, symbols }, createResearchToolExecutor({
        fetchFinancialContext: dependencies.fetchFinancialContext,
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
        listPortfolioSymbols: async () => (await portfolio.list()).map(({ symbol }) => symbol),
        fetchMarketPrices: dependencies.fetchMarketPrices,
        getPortfolioContext: (symbol, marketPrices) => portfolio.context(symbol, marketPrices),
      }, { symbols })({ threadId, knownFacts })),
      runtimeMinuteMs: dependencies.runtimeMinuteMs,
      activeNow: dependencies.activeNow,
      activeTimeoutSignal: dependencies.activeTimeoutSignal,
    })
    : undefined
  const tracking = dependencies.trackingRepository
    ? createTrackingService({
      repository: dependencies.trackingRepository,
      listPositionSymbols: async () => (await portfolio.list()).map(({ symbol }) => symbol),
      fetchTrackingQuotes: dependencies.fetchTrackingQuotes,
      getTechnicalEvidence: dependencies.getTechnicalEvidence,
      getFinancialOverview: dependencies.getFinancialOverview,
      listOfficialCompanyEvents: dependencies.listOfficialCompanyEvents,
      listCompanyEvents: dependencies.listCompanyEvents,
      now: dependencies.now,
      concurrency: dependencies.trackingConcurrency,
      scanIntervalMs: dependencies.trackingScanIntervalMs,
      onBackgroundError: dependencies.trackingBackgroundError,
      afterObservations: profitProtection ? async (observations, completedAt) => {
        const quoted = observations.filter((observation) => (
          observation.capability === 'technical'
          && nestedNumber(observation.payload, 'quote', 'price') !== null
        ))
        const prices = Object.fromEntries(quoted.flatMap((observation) => {
          const price = nestedNumber(observation.payload, 'quote', 'price')
          return price === null ? [] : [[observation.symbol, price]]
        }))
        const overview = await portfolio.overview(prices)
        const signals = Object.fromEntries(quoted.flatMap((observation) => {
          const price = nestedNumber(observation.payload, 'quote', 'price')
          if (price === null) return []
          return [[observation.symbol, {
            ema20: nestedNumber(observation.payload, 'technical', 'indicators', 'ma_20'),
            peakPrice: price,
            observedAt: observation.observedAt,
          }]]
        }))
        await profitProtection.observePortfolio({
          positions: overview.positions, signals, asOf: completedAt,
        })
      } : undefined,
    })
    : undefined


  return {
    portfolio, profitProtection, analysis, conversation, tracking, library, workbench,
    async initialize() { await tracking?.initialize() },
    async close() {
      await analysis.close()
      await conversation?.close()
      await tracking?.close()
      await dependencies.productDatabase.close()
    },
    async health() {
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
    },
    async portfolioOverview(force = false) {
      const positions = await portfolio.list()
      if (!positions.length) return portfolio.overview({})
      if (!dependencies.fetchMarketPrices && !dependencies.fetchMarketQuotes) return portfolio.overview({})
      try {
        const symbols = positions.map((position) => position.symbol)
        const signal = AbortSignal.timeout(dependencies.marketPriceTimeoutMs ?? MARKET_PRICE_REQUEST_TIMEOUT_MS)
        // refresh=1 由持仓页的「刷新行情」按钮触发：绕过短 TTL 缓存，但仍与已在途的取价合并。
        const batch = dependencies.fetchMarketQuotes
          ? await dependencies.fetchMarketQuotes(symbols, signal, { force: force })
          : null
        const prices = batch
          ? pricesFromSnapshots(batch.snapshots)
          : await dependencies.fetchMarketPrices!(symbols, signal)
        const overview = await portfolio.overview(prices)
        await portfolio.recordSnapshot(overview, dependencies.now?.() ?? new Date())
        return batch ? { ...overview, quotes: quoteFreshness(batch) } : overview
      } catch {
        return portfolio.overview({})
      }
    },
    async profitProtectionOverview() {
      if (!profitProtection) return null
      const positions = await portfolio.list()
      let prices: Record<string, number> = {}
      if (positions.length && dependencies.fetchMarketPrices) {
        try {
          prices = await dependencies.fetchMarketPrices(
            positions.map(({ symbol }) => symbol),
            AbortSignal.timeout(dependencies.marketPriceTimeoutMs ?? MARKET_PRICE_REQUEST_TIMEOUT_MS),
          )
        } catch {
          prices = {}
        }
      }
      const overview = await portfolio.overview(prices)
      const evaluated = await profitProtection.evaluatePortfolio({ positions: overview.positions })
      return {
        summary: {
          planned: evaluated.length,
          triggered: evaluated.filter(({ status }) => status === 'triggered').length,
          reviewRequired: evaluated.filter(({ status }) => status === 'review_required').length,
          dataGap: evaluated.filter(({ status }) => status === 'data_gap').length,
        },
        positions: evaluated,
        triggers: await profitProtection.listTriggers(),
      }
    },
    async saveProtectionPlan(symbol: string, input: Omit<Parameters<NonNullable<typeof profitProtection>['savePlan']>[0], 'symbol'>) {
      if (!profitProtection) return null
      const position = (await portfolio.list()).find((candidate) => candidate.symbol === symbol)
      if (!position) throw new Error('profit_protection_position_not_found')
      return profitProtection.savePlan({ ...input, symbol }, position, (dependencies.now?.() ?? new Date()).toISOString())
    },
    acknowledgeProtectionTrigger(id: string) {
      return profitProtection?.acknowledgeTrigger(id, (dependencies.now?.() ?? new Date()).toISOString())
    },
    settings: {
      async read() {
        return {
          model: { configured: dependencies.modelConfigured ?? Boolean(dependencies.model) },
          current: await dependencies.runtimeSettingsRepository.current(),
          defaults: defaultRuntimeSettings,
          activeExecutions: await dependencies.runtimeSettingsRepository.listActiveExecutionSnapshots(),
        }
      },
      async update(update: ReturnType<typeof parseRuntimeSettingsUpdate>) {
        const revision = await dependencies.runtimeSettingsRepository.save(update, (dependencies.now?.() ?? new Date()).toISOString())
        analysis.updateRuntimePolicy(revision.values)
        return revision
      },
      async restoreDefaults() {
        const revision = await dependencies.runtimeSettingsRepository.restoreDefaults((dependencies.now?.() ?? new Date()).toISOString())
        analysis.updateRuntimePolicy(revision.values)
        return revision
      },
    },
    conversationCapabilities() {
      return {
        capability: 'research',
        tools: conversationResearchTools.map(({ name, description, parameters }) => ({ name, description, parameters }))
          .concat((dependencies.searchWebEvidence ? conversationConditionalTools : []).map(({ name, description, parameters }) => ({ name, description, parameters, availability: 'conditional' }))),
      }
    },
    async conversationDetail(id: string) {
      const thread = await conversation?.get(id)
      if (!thread) return null
      const lifecycle = await dependencies.agentEventRepository.sessionLifecycle(thread.sessionId)
      return { thread, lifecycle: lifecycle ? projectResearchView(lifecycle) : null, sources: await library?.listSources(thread.id) ?? [] }
    },
    getAgentSession: (id: string) => dependencies.agentEventRepository.getSession(id),
    toolRuntime: (sessionId: string, executionId: string) => dependencies.toolProjectionRepository.replayForSession(sessionId, executionId),
    async researchExport(id: string) {
      const result = await analysis.research(id)
      if (!result) return null
      const configurationVersions = (await Promise.all(researchExecutionIds(result)
        .map((executionId) => dependencies.runtimeSettingsRepository.getExecutionSnapshot(executionId))))
        .filter((snapshot) => snapshot !== null)
      return projectResearchExport({ ...result, configurationVersions })
    },
    async reportVersions(id: string) {
      if (!await dependencies.analysisRepository.get(id)) return null
      return { items: (await dependencies.agentEventRepository.listReportVersions(id)).map(({ snapshot: _snapshot, ...version }) => version) }
    },
  }
}

export type ApplicationServices = ReturnType<typeof createApplicationServices>

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
