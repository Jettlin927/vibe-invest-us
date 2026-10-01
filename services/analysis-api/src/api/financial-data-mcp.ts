import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ConversationToolExecutor } from '../service/agent-runtime/model.js'
import type { RegisteredToolDefinition } from '../service/tool-registry.js'

type RememberedFact = { id: string; [key: string]: unknown }
export type FinancialDataTools = {
  definitions: RegisteredToolDefinition[]
  createExecutor: (knownFacts: Map<string, RememberedFact>) => ConversationToolExecutor
}

const TOOL_CALL_TIMEOUT_MS = 60_000
const MAX_REMEMBERED_FACTS = 2_000
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

// 只保存执行器返回的检索 facts；不保存工具结果中的持仓或凭据。
class RememberedFacts extends Map<string, RememberedFact> {
  override set(key: string, value: RememberedFact) {
    super.set(key, value)
    if (this.size > MAX_REMEMBERED_FACTS) this.delete(this.keys().next().value!)
    return this
  }
}

function result(value: Record<string, unknown>, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError }
}

export function createFinancialDataMcpServer(tools: FinancialDataTools, knownFacts: Map<string, RememberedFact>) {
  const server = new Server({ name: 'vibe-invest-financial-data', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: '只读金融数据工具，复用本实例的行情、财务、估值、技术、新闻与公告来源；所有事实带来源与观测时间，缺失数据形成明确缺口而不是补造数字。本端点不写入账本。',
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.definitions.map((definition) => ({
      name: definition.model.name,
      description: definition.model.description,
      inputSchema: definition.model.parameters as unknown as { type: 'object'; [key: string]: unknown },
      annotations: readAnnotations,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!tools.definitions.some((definition) => definition.model.name === request.params.name)) {
      return result({ error: 'unknown_tool' }, true)
    }
    try {
      const execute = tools.createExecutor(knownFacts)
      const outcome = await execute(request.params.name, request.params.arguments ?? {}, AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS), async () => {})
      return result(outcome.result, outcome.isError)
    } catch (error) {
      // 也覆盖执行器返回的异步拒绝，保留上游错误而不变成协议错误或成功。
      return result({ error: error instanceof Error ? error.message : String(error), facts: [] }, true)
    }
  })
  return server
}

// MCP 无会话；所有请求共用有界事实集合，使检索后按 factId 读取成立。
export function registerFinancialDataMcp(app: FastifyInstance, tools: FinancialDataTools, token?: string) {
  if (!token) return
  if (token.trim().length < 32) throw new Error('FINANCIAL_DATA_MCP_TOKEN must contain at least 32 characters')
  const expected = createHash('sha256').update(`Bearer ${token}`).digest()
  const knownFacts = new RememberedFacts()
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp/financial-data', bodyLimit: 32 * 1024,
    onRequest: async (request, reply) => {
      if (request.headers.origin) return reply.code(403).send({ error: 'origin_not_allowed' })
      const actual = createHash('sha256').update(request.headers.authorization ?? '').digest()
      if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'unauthorized' })
    },
    handler: async (request, reply) => {
      if (request.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' })
      const server = createFinancialDataMcpServer(tools, knownFacts)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      reply.hijack()
      reply.raw.on('close', () => { void server.close().catch(() => {}) })
      try { await transport.handleRequest(request.raw, reply.raw, request.body) } catch {
        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
        if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }))
      }
    },
  })
}
