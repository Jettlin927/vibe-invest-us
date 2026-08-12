import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import { formatSseEvent, type FinancialDataHealth } from '@vibe-invest/contracts'
import type { AgentEventRepository, AnalysisRepository, PortfolioRepository } from '@vibe-invest/product-dao'

import { createAnalysisService } from './analysis.js'
import type { ModelEvent } from './model.js'
import type { FactQueryResult, FinancialContext } from './financial-data-client.js'
import { createPortfolio, isValidSymbol, normalizeSymbol } from './portfolio.js'

type AppDependencies = {
  productDatabase: {
    checkSchema: () => Promise<{ status: 'ok'; version: number }>
    close: () => Promise<void>
  }
  portfolioRepository: PortfolioRepository
  analysisRepository: AnalysisRepository
  agentEventRepository: AgentEventRepository
  financialDataHealth: () => Promise<FinancialDataHealth>
  staticDir?: string
  fetchFinancialContext?: (symbol: string, signal: AbortSignal) => Promise<FinancialContext>
  searchNews?: (keyword: string, signal: AbortSignal) => Promise<FactQueryResult>
  fetchTechnicalIndicators?: (
    symbol: string, startDate: string, endDate: string, signal: AbortSignal,
  ) => Promise<FactQueryResult>
  fetchMarketPrices?: (symbols: string[], signal: AbortSignal) => Promise<Record<string, number>>
  model?: { analyze(input: Record<string, unknown>): AsyncIterable<ModelEvent> }
  analysisConcurrency?: number
  modelConfigured?: boolean
  now?: () => Date
  migrationVerificationToken?: string
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false })
  const portfolio = createPortfolio(dependencies.portfolioRepository)
  const analysis = dependencies.fetchFinancialContext && dependencies.model
    ? createAnalysisService({
        repository: dependencies.analysisRepository,
        eventRepository: dependencies.agentEventRepository,
        fetchFinancialContext: dependencies.fetchFinancialContext,
        searchNews: dependencies.searchNews,
        fetchTechnicalIndicators: dependencies.fetchTechnicalIndicators,
        fetchMarketPrices: dependencies.fetchMarketPrices,
        listPortfolioSymbols: async () => (await portfolio.list()).map((position) => position.symbol),
        model: dependencies.model,
        concurrency: dependencies.analysisConcurrency ?? 2,
        getPortfolioContext: (symbol, marketPrices) => portfolio.context(symbol, marketPrices),
      })
    : null

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
        AbortSignal.timeout(10_000),
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
  }))

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
    return result ?? reply.status(404).send({ error: 'analysis_not_found' })
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
        id: `${entry.sessionId}:${entry.sequence}`, event: String(event), data: payload,
      }))
    }
    reply.raw.end()
  })
  app.post<{ Params: { id: string } }>('/api/analyses/:id/cancel', async (request, reply) => {
    if (!await analysis?.cancel(request.params.id)) return reply.status(409).send({ error: 'analysis_not_cancellable' })
    return reply.status(202).send({ status: 'cancelling' })
  })
  app.get<{ Params: { id: string } }>('/api/research/:id', async (request, reply) => {
    const result = await analysis?.research(request.params.id)
    return result ?? reply.status(404).send({ error: 'research_not_found' })
  })
  app.get<{ Querystring: { symbol?: string } }>('/api/research', async (request) => ({
    records: await analysis?.listResearch(request.query.symbol) ?? [],
  }))
  app.patch<{
    Params: { id: string }
    Body: { starred?: unknown; note?: unknown }
  }>('/api/research/:id', async (request, reply) => {
    const { starred, note } = request.body ?? {}
    if ((starred !== undefined && typeof starred !== 'boolean') || (note !== undefined && typeof note !== 'string')) {
      return reply.status(400).send({ error: 'invalid_research_update' })
    }
    const result = await analysis?.updateResearch(request.params.id, { starred, note })
    return result ?? reply.status(404).send({ error: 'research_not_found' })
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
