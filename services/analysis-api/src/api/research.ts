import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { projectResearchView } from '../service/research-export.js'

export function registerResearchRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { analysis } = services
  app.get<{ Params: { id: string }; Querystring: { reportVersionId?: string } }>('/api/research/:id', async (request, reply) => {
    const result = await analysis?.researchView(request.params.id, request.query.reportVersionId)
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'research_not_found' })
  })

  app.get<{ Params: { id: string } }>('/api/research/:id/trace', async (request, reply) => {
    const result = await analysis?.researchTrace(request.params.id)
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'research_not_found' })
  })

  app.get<{ Params: { id: string } }>('/api/research/:id/export', async (request, reply) => {
    const result = await services.researchExport(request.params.id)
    if (!result) return reply.status(404).send({ error: 'research_not_found' })
    reply.header('content-disposition', 'attachment; filename="research.json"')
    return result
  })

  app.get<{ Params: { id: string } }>('/api/research/:id/report-versions', async (request, reply) => {
    const result = await services.reportVersions(request.params.id)
    return result ? projectResearchView(result) : reply.status(404).send({ error: 'analysis_not_found' })
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
}
