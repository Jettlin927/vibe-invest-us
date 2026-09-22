import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { isValidSymbol, normalizeSymbol } from '@vibe-invest/domain/portfolio'

export function registerTrackingRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { tracking } = services
  app.get<{ Querystring: { symbol?: string; limit?: string } }>('/api/tracking', async (request, reply) => {
    if (!tracking) return reply.status(404).send({ error: 'tracking_unavailable' })
    const symbol = typeof request.query.symbol === 'string'
      ? normalizeSymbol(request.query.symbol) : undefined
    return tracking.state({
      ...(symbol ? { symbol } : {}),
      limit: Number(request.query.limit ?? 100),
    })
  })

  app.put<{
    Params: { symbol: string }; Body: { note?: unknown; enabled?: unknown }
  }>('/api/tracking/watchlist/:symbol', async (request, reply) => {
    if (!tracking) return reply.status(404).send({ error: 'tracking_unavailable' })
    const symbol = normalizeSymbol(request.params.symbol)
    const note = request.body?.note
    const enabled = request.body?.enabled
    if (!isValidSymbol(symbol)
      || (note !== undefined && (typeof note !== 'string' || note.length > 500))
      || (enabled !== undefined && typeof enabled !== 'boolean')) {
      return reply.status(400).send({ error: 'invalid_watchlist_item' })
    }
    return tracking.putWatchlist(symbol, {
      ...(typeof note === 'string' ? { note: note.trim() } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
    })
  })

  app.delete<{ Params: { symbol: string } }>(
    '/api/tracking/watchlist/:symbol', async (request, reply) => {
      if (!tracking) return reply.status(404).send({ error: 'tracking_unavailable' })
      const symbol = normalizeSymbol(request.params.symbol)
      if (!isValidSymbol(symbol)) return reply.status(400).send({ error: 'invalid_symbol' })
      await tracking.removeWatchlist(symbol)
      return reply.status(204).send()
    },
  )

  app.post('/api/tracking/scans', async (_request, reply) => {
    if (!tracking) return reply.status(404).send({ error: 'tracking_unavailable' })
    try {
      return reply.status(202).send(await tracking.startScan())
    } catch (error) {
      if (error instanceof Error && error.message === 'tracking_run_active') {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })

  app.get<{ Params: { id: string } }>('/api/tracking/scans/:id', async (request, reply) => {
    if (!tracking) return reply.status(404).send({ error: 'tracking_unavailable' })
    const scan = await tracking.getScan(request.params.id)
    return scan ?? reply.status(404).send({ error: 'tracking_scan_not_found' })
  })
}
