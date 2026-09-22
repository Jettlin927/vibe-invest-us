import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { isValidSymbol, normalizeSymbol } from '@vibe-invest/domain/portfolio'

export function registerPortfolioRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { portfolio, profitProtection } = services
  app.get('/api/positions', async () => ({ positions: await portfolio.list() }))

  app.get('/api/portfolio/stored', async () => portfolio.overview({}))

  app.get('/api/profit-protection', async (_request, reply) => {
    if (!profitProtection) return reply.status(404).send({ error: 'profit_protection_unavailable' })
    return services.profitProtectionOverview()
  })

  app.put<{
    Params: { symbol: string }
    Body: {
      anchorPrice?: unknown; invalidationPrice?: unknown
      coreRatio?: unknown; maxPortfolioWeight?: unknown
      earningsDate?: unknown; earningsRiskStartsAt?: unknown
    }
  }>('/api/positions/:symbol/profit-protection', async (request, reply) => {
    if (!profitProtection) return reply.status(404).send({ error: 'profit_protection_unavailable' })
    const symbol = normalizeSymbol(request.params.symbol)
    if (!isValidSymbol(symbol)) {
      return reply.status(404).send({ error: 'profit_protection_position_not_found' })
    }
    const {
      anchorPrice, invalidationPrice, coreRatio, maxPortfolioWeight,
      earningsDate, earningsRiskStartsAt,
    } = request.body ?? {}
    if (![anchorPrice, invalidationPrice, coreRatio, maxPortfolioWeight]
      .every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return reply.status(400).send({ error: 'invalid_profit_protection_plan' })
    }
    try {
      return await services.saveProtectionPlan(symbol, {
        anchorPrice: anchorPrice as number,
        invalidationPrice: invalidationPrice as number,
        coreRatio: coreRatio as number,
        maxPortfolioWeight: maxPortfolioWeight as number,
        earningsDate: typeof earningsDate === 'string' && earningsDate ? earningsDate : null,
        earningsRiskStartsAt: typeof earningsRiskStartsAt === 'string' && earningsRiskStartsAt
          ? earningsRiskStartsAt : null,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'profit_protection_position_not_found') return reply.status(404).send({ error: error.message })
      if (error instanceof Error && (
        error.message.startsWith('profit_protection_')
        || error.message === 'invalid_profit_protection_plan'
      )) {
        return reply.status(400).send({ error: error.message })
      }
      throw error
    }
  })

  app.post<{ Params: { id: string } }>(
    '/api/profit-protection/triggers/:id/acknowledge', async (request, reply) => {
      if (!profitProtection) return reply.status(404).send({ error: 'profit_protection_unavailable' })
      const trigger = await services.acknowledgeProtectionTrigger(request.params.id)
      return trigger ?? reply.status(404).send({ error: 'profit_protection_trigger_not_found' })
    },
  )

  app.get<{ Querystring: { refresh?: string } }>('/api/portfolio', async (request, reply) => {
    return services.portfolioOverview(request.query.refresh === '1')
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
    const result = await portfolio.adjustCash(cash)
    if (!result) return reply.status(400).send({ error: 'invalid_cash' })
    return { cash: result.cash }
  })

  app.get<{ Querystring: { limit?: string } }>('/api/portfolio/events', async (request) => ({
    events: await portfolio.listEvents(Number(request.query.limit ?? 100)),
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
      const result = await portfolio.reconcile({ symbol, quantity, averageCost })
      return result.position
    },
  )

  app.post<{
    Params: { symbol: string }
    Body: { quantity?: unknown; price?: unknown }
  }>('/api/positions/:symbol/buy', async (request, reply) => {
    const symbol = normalizeSymbol(request.params.symbol)
    const { quantity, price } = request.body ?? {}
    if (
      !isValidSymbol(symbol)
      || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0
      || typeof price !== 'number' || !Number.isFinite(price) || price < 0
    ) return reply.status(400).send({ error: 'invalid_purchase' })
    const result = await portfolio.recordBuy(symbol, quantity, price)
    if (!result) return reply.status(400).send({ error: 'insufficient_cash' })
    return { position: result.position, cash: result.cash, spent: result.spent }
  })

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
    const result = await portfolio.recordSell(symbol, quantity, price)
    if (!result) return reply.status(400).send({ error: 'reduction_exceeds_position' })
    return {
      position: result.position, cash: result.cash,
      proceeds: result.proceeds, realizedProfitLoss: result.realizedProfitLoss,
    }
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
}
