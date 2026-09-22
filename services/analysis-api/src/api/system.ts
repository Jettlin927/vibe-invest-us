import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'

export function registerSystemRoutes(app: FastifyInstance, services: ApplicationServices, options: { migrationVerificationToken?: string }) {
  const { portfolio, analysis } = services
  app.get('/api/health', async (_request, reply) => {
    try {
      return await services.health()
    } catch {
      return reply.status(503).send({
        service: 'analysis-api',
        status: 'unavailable',
      })
    }
  })

  app.get('/api/migration-verification', async (request, reply) => {
    const token = options.migrationVerificationToken
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.status(404).send({ error: 'not_found' })
    }
    return portfolio.migrationVerificationState()
  })
}
