import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { isValidSymbol, normalizeSymbol } from '@vibe-invest/domain/portfolio'
import { projectResearchView } from '../service/research-export.js'
import { formatSseEvent } from '@vibe-invest/contracts'
import { parseLastEventId } from './sse.js'

export function registerAnalysisRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { analysis } = services
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
      const session = await services.getAgentSession(request.params.id)
      if (!session) return reply.status(404).send({ error: 'agent_session_not_found' })
      const executionId = request.query.executionId ?? session.executionId
      const runtime = await services.toolRuntime(
        session.id, executionId,
      )
      return runtime
        ? projectResearchView(runtime)
        : reply.status(404).send({ error: 'agent_execution_not_found' })
    })

  app.get<{ Params: { id: string }; Headers: { 'last-event-id'?: string } }>(
    '/api/agent-sessions/:id/events', async (request, reply) => {
      const currentAnalysis = analysis
      if (!currentAnalysis || !await services.getAgentSession(request.params.id)) {
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
}
