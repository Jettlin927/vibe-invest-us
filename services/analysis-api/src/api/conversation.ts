import type { FastifyInstance } from 'fastify'
import type { ApplicationServices } from '../service/application.js'
import { projectResearchView } from '../service/research-export.js'
import { formatSseEvent } from '@vibe-invest/contracts'
import { parseLastEventId, parseEventSequence } from './sse.js'

export function registerConversationRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { conversation } = services
  app.post<{
    Body: { message?: unknown; messageId?: unknown; title?: unknown }
  }>('/api/conversations', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return reply.status(400).send({ error: 'conversation_message_required' })
    }
    const messageId = typeof request.body.messageId === 'string' && request.body.messageId.trim()
      ? request.body.messageId.trim() : undefined
    if (messageId && messageId.length > 200) return reply.status(400).send({ error: 'conversation_message_id_invalid' })
    const title = typeof request.body.title === 'string' ? request.body.title.trim() : undefined
    const result = await conversation.create(request.body.message, messageId, title)
    return reply.status(202).send(result)
  })

  app.get('/api/conversations/capabilities', async (_request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    return services.conversationCapabilities()
  })

  app.get('/api/conversations', async (_request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    return { threads: await conversation.list() }
  })

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    return await services.conversationDetail(request.params.id) ?? reply.status(404).send({ error: 'conversation_not_found' })
  })

  app.get<{ Params: { id: string } }>('/api/conversations/:id/children', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    const thread = await conversation.get(request.params.id)
    if (!thread) return reply.status(404).send({ error: 'conversation_not_found' })
    return { threads: await conversation.children(request.params.id) }
  })

  app.post<{
    Params: { id: string }
    Body: { message?: unknown; messageId?: unknown }
  }>('/api/conversations/:id/messages', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return reply.status(400).send({ error: 'conversation_message_required' })
    }
    const messageId = typeof request.body.messageId === 'string' && request.body.messageId.trim()
      ? request.body.messageId.trim() : undefined
    if (messageId && messageId.length > 200) return reply.status(400).send({ error: 'conversation_message_id_invalid' })
    try {
      const result = await conversation.sendMessage(request.params.id, request.body.message, messageId)
      return result ? reply.status(202).send(result) : reply.status(404).send({ error: 'conversation_not_found' })
    } catch (error) {
      if (error instanceof Error && ['conversation_run_active', 'agent_operation_conflict'].includes(error.message)) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })

  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', async (request, reply) => {
    if (!conversation || !await conversation.cancel(request.params.id)) {
      return reply.status(409).send({ error: 'conversation_not_cancellable' })
    }
    return reply.status(202).send({ status: 'cancelling' })
  })

  app.post<{
    Params: { id: string }; Body: { message?: unknown; messageId?: unknown }
  }>('/api/conversations/:id/steer', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return reply.status(400).send({ error: 'conversation_message_required' })
    }
    const messageId = typeof request.body.messageId === 'string' && request.body.messageId.trim()
      ? request.body.messageId.trim() : undefined
    if (messageId && messageId.length > 200) return reply.status(400).send({ error: 'conversation_message_id_invalid' })
    const result = await conversation.steer(request.params.id, request.body.message, messageId)
    return result ? reply.status(202).send(result) : reply.status(404).send({ error: 'conversation_not_found' })
  })

  app.post<{ Params: { id: string } }>('/api/conversations/:id/resume', async (request, reply) => {
    if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
    const result = await conversation.resume(request.params.id)
    return result ? reply.status(202).send(result) : reply.status(409).send({ error: 'conversation_not_resumable' })
  })

  app.get<{
    Params: { id: string }
    Headers: { 'last-event-id'?: string }
    Querystring: { after?: string }
  }>(
    '/api/conversations/:id/events', async (request, reply) => {
      if (!conversation) return reply.status(404).send({ error: 'conversation_unavailable' })
      const thread = await conversation.get(request.params.id)
      if (!thread) return reply.status(404).send({ error: 'conversation_not_found' })
      const headerCursor = parseLastEventId(request.headers['last-event-id'], thread.sessionId)
      const queryCursor = request.query.after === undefined
        ? 0 : parseEventSequence(request.query.after)
      const cursor = headerCursor === 0 && request.query.after !== undefined ? queryCursor : headerCursor
      if (cursor === null) return reply.status(400).send({ error: 'invalid_last_event_id' })
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache', connection: 'keep-alive',
      })
      const controller = new AbortController()
      request.raw.on('close', () => controller.abort())
      for await (const entry of conversation.streamEvents(thread.sessionId, cursor, controller.signal)) {
        const payload = projectResearchView(entry.payload)
        const event = payload.type === 'status' ? payload.status : payload.type
        reply.raw.write(formatSseEvent({
          id: `${entry.sessionId}:${entry.sequence}`, event: String(event), data: payload,
        }))
      }
      reply.raw.end()
    })
}
