import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'

export function registerWorkbenchRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { library, workbench } = services
  if (library) {
    app.get<{ Querystring: { q?: string; symbol?: string; offset?: string; limit?: string } }>('/api/research-library', async (request) => library.search({
      q: request.query.q, symbol: request.query.symbol, offset: Number(request.query.offset ?? 0), limit: Number(request.query.limit ?? 20),
    }))
    app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>('/api/research-library/:id', async (request, reply) => {
      const result = await library.read(request.params.id, Number(request.query.offset ?? 0), Number(request.query.limit ?? 30))
      return result ?? reply.status(404).send({ error: 'research_record_not_found' })
    })
  }

  if (workbench) {
    const write = async (action: () => Promise<unknown>, reply: import('fastify').FastifyReply) => {
      try { return await action() }
      catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.startsWith('invalid_workbench_')) return reply.status(400).send({ error: message })
        if (message.endsWith('_not_found')) return reply.status(404).send({ error: message })
        if (message.endsWith('_conflict')) return reply.status(409).send({ error: message })
        throw error
      }
    }
    app.get('/api/workbench/pages', async () => ({ pages: await workbench.listPages() }))
    app.post('/api/workbench/pages', async (request, reply) => write(async () => ({ page: await workbench.savePage(request.body) }), reply))
    app.get<{ Params: { id: string } }>('/api/workbench/pages/:id', async (request, reply) => (
      await workbench.getPage(request.params.id) ?? reply.status(404).send({ error: 'workbench_page_not_found' })
    ))
    app.post<{ Params: { id: string }; Body: { operationId: string; revision: number } }>('/api/workbench/pages/:id/restore', async (request, reply) => write(async () => ({
      page: await workbench.restorePage({ ...request.body, id: request.params.id }),
    }), reply))
    app.get('/api/workbench/stances', async () => ({ stances: await workbench.listStances() }))
    app.post('/api/workbench/stances', async (request, reply) => write(async () => ({ stance: await workbench.saveStance(request.body) }), reply))
  }
}
