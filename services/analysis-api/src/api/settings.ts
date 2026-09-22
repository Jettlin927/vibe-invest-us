import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { parseRuntimeSettingsUpdate } from '@vibe-invest/contracts'

export function registerSettingsRoutes(app: FastifyInstance, services: ApplicationServices) {
  app.get('/api/settings', async () => services.settings.read())

  app.put<{ Body: unknown }>('/api/settings', async (request, reply) => {
    let update
    try {
      update = parseRuntimeSettingsUpdate(request.body)
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'invalid_runtime_settings_update' })
    }
    return services.settings.update(update)
  })

  app.post('/api/settings/defaults', async () => services.settings.restoreDefaults())
}
