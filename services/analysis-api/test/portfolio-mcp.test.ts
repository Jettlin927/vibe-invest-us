import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createPool, createPortfolioRepository, migrate } from '@vibe-invest/product-dao'
import { registerPortfolioMcp } from '../src/portfolio-mcp.js'

const token = 'portfolio-test-token-at-least-32-characters'
const databaseUrl = process.env.TEST_DATABASE_URL

test('MCP 默认关闭，认证和浏览器来源检查先于账本访问', async () => {
  const pool = createPool('postgresql://unused:unused@127.0.0.1:1/unused')
  const repository = createPortfolioRepository(pool)
  const off = Fastify()
  registerPortfolioMcp(off, repository)
  assert.equal((await off.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode, 404)
  await off.close()
  const app = Fastify()
  registerPortfolioMcp(app, repository, token)
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    assert.equal((await app.inject({ method, url: '/mcp' })).statusCode, 401)
  }
  assert.equal((await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${token}` } })).statusCode, 405)
  await app.close()
  await pool.end()
})

test('真实 MCP HTTP + PostgreSQL：买卖、校准、现金、并发重试、冲突与重启读回', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /test/, '只能使用隔离测试数据库')
  await migrate(databaseUrl!)
  const pool = createPool(databaseUrl!)
  const repository = createPortfolioRepository(pool)
  const prefix = `mcp-test-${Date.now()}`
  let app = Fastify()
  registerPortfolioMcp(app, repository, token)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
  async function connect() {
    const client = new Client({ name: 'portfolio-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    return client
  }
  let client = await connect()
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args })
    return { response, value: response.structuredContent as any }
  }
  try {
    const tools = (await client.listTools()).tools
    assert.deepEqual(tools.map(t => t.name).sort(), ['adjust_cash', 'get_portfolio', 'list_portfolio_events', 'reconcile_position', 'record_portfolio_trade'])
    assert.equal(tools.filter(t => t.annotations?.readOnlyHint).length, 2)
    await call('reconcile_position', { symbol: 'MCPTEST', quantity: 0, averageCost: 0, operationId: `${prefix}-clear` })
    await call('adjust_cash', { cash: 1000, operationId: `${prefix}-cash` })
    const buy = { symbol: 'MCPTEST', side: 'buy', quantity: 2, price: 100, operationId: `${prefix}-buy` }
    const results = await Promise.all([call('record_portfolio_trade', buy), call('record_portfolio_trade', buy)])
    assert.equal(results[0].response.isError, undefined)
    assert.deepEqual(results[0].value, results[1].value)
    assert.equal(results[0].value.cash, 800)
    assert.equal((await call('record_portfolio_trade', { ...buy, quantity: 3 })).value.error, 'portfolio_operation_conflict')
    assert.equal((await call('record_portfolio_trade', { ...buy, quantity: 100, operationId: `${prefix}-too-much` })).value.error, 'insufficient_cash')
    assert.equal((await call('record_portfolio_trade', { ...buy, side: 'sell', quantity: 3, operationId: `${prefix}-oversell` })).value.error, 'insufficient_position')
    assert.equal((await call('record_portfolio_trade', { ...buy, quantity: -1 })).response.isError, true)
    assert.equal((await call('record_portfolio_trade', { ...buy, unexpected: true })).response.isError, true)
    const sold = await call('record_portfolio_trade', { ...buy, side: 'sell', quantity: 1, price: 120, operationId: `${prefix}-sell` })
    assert.equal(sold.value.cash, 920)
    assert.equal(sold.value.realizedProfitLoss, 20)
    // 较早的资金操作重试，不能覆盖后来卖出所得。
    await call('adjust_cash', { cash: 1000, operationId: `${prefix}-cash` })
    assert.equal((await call('get_portfolio')).value.cash, 920)
    assert.equal((await call('adjust_cash', { cash: 1001, operationId: `${prefix}-cash` })).value.error, 'portfolio_operation_conflict')
    const reconcile = { symbol: 'MCPTEST', quantity: 5, averageCost: 90, operationId: `${prefix}-reconcile` }
    const reconciled = await Promise.all([call('reconcile_position', reconcile), call('reconcile_position', reconcile)])
    assert.deepEqual(reconciled[0].value, reconciled[1].value)
    await call('record_portfolio_trade', { ...buy, operationId: `${prefix}-buy-again` })
    await call('reconcile_position', reconcile)
    assert.equal((await call('reconcile_position', { ...reconcile, quantity: 6 })).value.error, 'portfolio_operation_conflict')
    // 目标余额未变化也必须持久化 operationId。
    await call('adjust_cash', { cash: 720, operationId: `${prefix}-noop` })
    await call('adjust_cash', { cash: 700, operationId: `${prefix}-later` })
    await call('adjust_cash', { cash: 720, operationId: `${prefix}-noop` })
    await client.close()
    await app.close()
    app = Fastify()
    registerPortfolioMcp(app, createPortfolioRepository(pool), token)
    await app.listen({ host: '127.0.0.1', port: address.port })
    client = await connect()
    const current = (await call('get_portfolio')).value
    assert.equal(current.cash, 700)
    assert.equal(current.positions.find((p: any) => p.symbol === 'MCPTEST').quantity, 7)
    assert.equal(current.totalEquity, null)
    const events = (await call('list_portfolio_events', { limit: 500 })).value.events
    assert.equal(events.filter((e: any) => e.id === results[0].value.event.id).length, 1)
    assert.equal(events.filter((e: any) => e.id === reconciled[0].value.event.id).length, 1)
  } finally {
    await client.close()
    await app.close()
    await pool.end()
  }
})
