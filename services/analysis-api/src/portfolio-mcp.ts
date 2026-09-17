import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import type { PortfolioRepository } from '@vibe-invest/product-dao'
import { createPortfolio } from './portfolio.js'

const symbol = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/)
const amount = z.number().finite().nonnegative().max(1e12)
const operationId = z.string().trim().min(1).max(150).describe('本次记账唯一 ID；超时或重试必须沿用，相同 ID 不得用于不同参数')
const note = z.string().max(500).default('').describe('用户提供的成交时间、记录来源或校准原因；不要虚构')
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
async function execute(action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try { return result(await action()) } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const known = ['portfolio_operation_conflict', 'insufficient_cash', 'insufficient_position', 'invalid_cash']
    return { ...result({ error: known.includes(message) ? message : 'portfolio_unavailable',
      guidance: '失败或响应不确定时先读取账本；重试沿用 operationId，不得换 ID 重复记账。' }), isError: true }
  }
}

export function createPortfolioMcpServer(repository: PortfolioRepository) {
  const portfolio = createPortfolio(repository)
  const server = new McpServer({ name: 'vibe-invest-portfolio', version: '1.0.0' }, {
    instructions: '管理用户自托管实例的持仓账本，不连接券商。只有用户明确要求登记已成交买卖或校准实际余额时才能写入；计划、建议和未成交订单不得记账。写入后调用 get_portfolio 读回当前状态。事件时间是记账时间，实际成交时间可写入 note。',
  })
  server.registerTool('get_portfolio', {
    description: '读取当前持仓数量、平均成本和 USD 现金。无实时行情；不能据此推断当前市值。',
    inputSchema: z.object({}).strict(), annotations: readAnnotations,
  }, () => execute(async () => ({ ...await portfolio.overview({}), source: 'vibe-invest-us portfolio ledger', fetchedAt: new Date().toISOString(), gaps: ['未刷新市场行情'] })))
  server.registerTool('list_portfolio_events', {
    description: '读取最近记账事件；最多 500 条，不保证完整历史。',
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict(), annotations: readAnnotations,
  }, ({ limit }) => execute(async () => ({ events: await repository.listEvents(limit), limit, fetchedAt: new Date().toISOString() })))
  server.registerTool('record_portfolio_trade', {
    description: '仅登记用户明确要求记录的已成交买卖，需要实际数量和成交价。买入扣现金并更新平均成本，卖出增加现金并记录已实现盈亏；不下单。',
    inputSchema: z.object({ symbol, side: z.enum(['buy', 'sell']), quantity: amount.positive().max(1e9), price: amount.positive(), operationId, note }).strict(), annotations: writeAnnotations,
  }, (input) => execute(async () => {
    const key = `mcp:${input.operationId}`
    const trade = input.side === 'buy'
      ? await repository.recordBuy(input.symbol, input.quantity, input.price, input.note, key)
      : await repository.recordSell(input.symbol, input.quantity, input.price, input.note, key)
    if (!trade) throw new Error(input.side === 'buy' ? 'insufficient_cash' : 'insufficient_position')
    return { ...trade, operationId: input.operationId }
  }))
  server.registerTool('reconcile_position', {
    description: '按用户明确提供的实际持仓校准数量和平均成本，现金不变。quantity=0 清空此标的并留校准事件；不是卖出。',
    inputSchema: z.object({ symbol, quantity: amount.max(1e9), averageCost: amount, operationId, note }).strict(), annotations: writeAnnotations,
  }, (input) => execute(async () => ({
    ...await repository.recordReconcile(input.symbol, input.quantity, input.averageCost, input.note, `mcp:${input.operationId}`), operationId: input.operationId,
  })))
  server.registerTool('adjust_cash', {
    description: '按用户明确提供的 USD 实际现金余额校准，cash 是目标余额而非增减额；自动记录差额，不修改持仓。',
    inputSchema: z.object({ cash: amount, operationId, note }).strict(), annotations: writeAnnotations,
  }, (input) => execute(async () => {
    const adjustment = await repository.recordCashAdjustment(input.cash, input.note, `mcp:${input.operationId}`)
    if (!adjustment) throw new Error('invalid_cash')
    return { ...adjustment, operationId: input.operationId }
  }))
  return server
}

// 每次请求独立实例；无会话状态，业务幂等性由 PostgreSQL 事务保证。
export function registerPortfolioMcp(app: FastifyInstance, repository: PortfolioRepository, token?: string) {
  if (!token) return
  if (token.trim().length < 32) throw new Error('PORTFOLIO_MCP_TOKEN must contain at least 32 characters')
  const expected = createHash('sha256').update(`Bearer ${token}`).digest()
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp', bodyLimit: 32 * 1024,
    onRequest: async (request, reply) => {
      // 仅原生 MCP 客户端；拒绝浏览器跨源请求。
      if (request.headers.origin) return reply.code(403).send({ error: 'origin_not_allowed' })
      const actual = createHash('sha256').update(request.headers.authorization ?? '').digest()
      if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'unauthorized' })
    },
    handler: async (request, reply) => {
      if (request.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' })
      const server = createPortfolioMcpServer(repository)
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
