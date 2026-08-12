import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import type { FinancialDataHealth } from '@vibe-invest/contracts'

import { createAnalysisService } from './analysis.js'
import { openDatabase } from './database.js'
import type { ModelEvent } from './model.js'
import type { FactQueryResult, FinancialContext } from './financial-data-client.js'
import { createPortfolio, isValidSymbol, normalizeSymbol } from './portfolio.js'

type AppDependencies = {
  databasePath: string
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
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false })
  const database = openDatabase(dependencies.databasePath)
  const portfolio = createPortfolio(database)
  const analysis = dependencies.fetchFinancialContext && dependencies.model
    ? createAnalysisService({
        database,
        fetchFinancialContext: dependencies.fetchFinancialContext,
        searchNews: dependencies.searchNews,
        fetchTechnicalIndicators: dependencies.fetchTechnicalIndicators,
        fetchMarketPrices: dependencies.fetchMarketPrices,
        listPortfolioSymbols: () => portfolio.list().map((position) => position.symbol),
        model: dependencies.model,
        concurrency: dependencies.analysisConcurrency ?? 2,
        getPortfolioContext: (symbol, marketPrices) => portfolio.context(symbol, marketPrices),
      })
    : null

  app.addHook('onClose', async () => { analysis?.close(); database.close() })

  if (dependencies.staticDir) {
    void app.register(fastifyStatic, {
      root: dependencies.staticDir,
    })
  }

  app.get('/api/health', async (_request, reply) => {
    try {
      database.exec('PRAGMA user_version')
      const financialData = await dependencies.financialDataHealth()

      return {
        service: 'analysis-api',
        status: 'ok',
        dependencies: {
          database: { status: 'ok' },
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

  app.get('/api/positions', async () => ({ positions: portfolio.list() }))

  app.get('/api/portfolio', async (_request, reply) => {
    const positions = portfolio.list()
    if (!positions.length) return portfolio.overview({})
    if (!dependencies.fetchMarketPrices) return portfolio.overview({})
    try {
      const prices = await dependencies.fetchMarketPrices(
        positions.map((position) => position.symbol),
        AbortSignal.timeout(10_000),
      )
      const overview = portfolio.overview(prices)
      portfolio.recordSnapshot(overview, dependencies.now?.() ?? new Date())
      return overview
    } catch {
      return reply.status(200).send(portfolio.overview({}))
    }
  })

  app.get<{ Querystring: { limit?: string } }>('/api/portfolio/history', async (request) => ({
    currency: 'USD',
    snapshots: portfolio.history(Number(request.query.limit ?? 30)),
  }))

  app.put<{ Body: { cash?: unknown } }>('/api/portfolio/cash', async (request, reply) => {
    const cash = request.body?.cash
    if (typeof cash !== 'number' || !Number.isFinite(cash) || cash < 0) {
      return reply.status(400).send({ error: 'invalid_cash' })
    }
    return { cash: portfolio.setCash(cash) }
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
    portfolio.remove(symbol)
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
    const result = portfolio.reduce(symbol, quantity, price)
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
    const result = analysis.create(symbol)
    return reply.status(202).send(result)
  })
  app.get<{ Params: { id: string } }>('/api/analyses/:id', async (request, reply) => {
    const result = analysis?.get(request.params.id)
    return result ?? reply.status(404).send({ error: 'analysis_not_found' })
  })
  app.get<{ Params: { id: string } }>('/api/analyses/:id/events', async (request, reply) => {
    if (!analysis?.get(request.params.id)) return reply.status(404).send({ error: 'analysis_not_found' })
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const controller = new AbortController()
    request.raw.on('close', () => controller.abort())
    for await (const entry of analysis.streamEvents(request.params.id, controller.signal)) {
      const event = entry.type === 'status' ? entry.status : entry.type
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(entry)}\n\n`)
    }
    reply.raw.end()
  })
  app.post<{ Params: { id: string } }>('/api/analyses/:id/cancel', async (request, reply) => {
    if (!analysis?.cancel(request.params.id)) return reply.status(409).send({ error: 'analysis_not_cancellable' })
    return reply.status(202).send({ status: 'cancelling' })
  })
  app.get<{ Params: { id: string } }>('/api/research/:id', async (request, reply) => {
    const result = analysis?.research(request.params.id)
    return result ?? reply.status(404).send({ error: 'research_not_found' })
  })
  app.get<{ Querystring: { symbol?: string } }>('/api/research', async (request) => ({
    records: analysis?.listResearch(request.query.symbol) ?? [],
  }))
  app.patch<{
    Params: { id: string }
    Body: { starred?: unknown; note?: unknown }
  }>('/api/research/:id', async (request, reply) => {
    const { starred, note } = request.body ?? {}
    if ((starred !== undefined && typeof starred !== 'boolean') || (note !== undefined && typeof note !== 'string')) {
      return reply.status(400).send({ error: 'invalid_research_update' })
    }
    const result = analysis?.updateResearch(request.params.id, { starred, note })
    return result ?? reply.status(404).send({ error: 'research_not_found' })
  })
  app.delete<{ Params: { id: string } }>('/api/research/:id', async (request, reply) => {
    if (!analysis?.removeResearch(request.params.id)) return reply.status(404).send({ error: 'research_not_found' })
    return reply.status(204).send()
  })

  return app
}
