import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerFinancialDataMcp, type FinancialDataTools } from '../src/api/financial-data-mcp.js'
import { createResearchToolExecutor, type ResearchCapabilityOptions } from '../src/service/research-capability.js'
import { financialDataToolDefinitions, registeredToolDefinitions } from '../src/service/tool-registry.js'

const token = 'financial-data-test-token-at-least-32-characters'
const expectedNames = [
  'fetch_financial_context', 'get_financial_overview', 'get_financial_metric_series',
  'get_valuation_evidence', 'get_technical_evidence', 'get_price_window',
  'list_company_events', 'search_news_candidates', 'read_news_document',
  'read_filing_document', 'search_web_evidence', 'get_company_dossier',
  'get_market_structure', 'get_market_quotes', 'get_research_context',
  'compare_securities', 'get_portfolio_exposure', 'search_evidence', 'read_evidence',
].sort()
const news = {
  id: 'fact:news:1', type: 'news', value: { title: 'Product launch' },
  observedAt: '2026-09-30T10:00:00Z', fetchedAt: '2026-09-30T10:01:00Z',
  source: 'news-source', sourceReference: 'https://example.com/news', evidenceLevel: 'title_only',
}

function researchTools(options: ResearchCapabilityOptions = {}): FinancialDataTools {
  return {
    definitions: financialDataToolDefinitions,
    createExecutor: (knownFacts) => createResearchToolExecutor(options)({
      threadId: 'mcp-financial-data-test', knownFacts,
    }),
  }
}

async function startMcp(options: ResearchCapabilityOptions = {}) {
  const app = Fastify()
  registerFinancialDataMcp(app, researchTools(options), token)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/financial-data`)
  const clients: Client[] = []
  return {
    async connect() {
      const client = new Client({ name: 'financial-data-test', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()))
      await app.close()
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args })
  assert.ok(response.structuredContent && typeof response.structuredContent === 'object')
  const value = response.structuredContent as Record<string, unknown>
  assert.ok(Array.isArray(response.content))
  const text = response.content.find((item) => item.type === 'text')
  assert.ok(text && text.type === 'text')
  assert.deepEqual(JSON.parse(text.text), value)
  return { response, value }
}

test('金融数据 MCP 默认关闭，短令牌、认证、来源和方法检查先于工具执行', async (t) => {
  let executions = 0
  const tools: FinancialDataTools = {
    definitions: financialDataToolDefinitions,
    createExecutor: () => {
      executions += 1
      return async () => ({ result: {}, isError: false })
    },
  }
  const off = Fastify()
  t.after(() => off.close())
  registerFinancialDataMcp(off, tools)
  assert.equal((await off.inject({ method: 'POST', url: '/mcp/financial-data', payload: {} })).statusCode, 404)
  assert.throws(() => registerFinancialDataMcp(off, tools, 'short-token'), {
    message: 'FINANCIAL_DATA_MCP_TOKEN must contain at least 32 characters',
  })
  const app = Fastify()
  t.after(() => app.close())
  registerFinancialDataMcp(app, tools, token)
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    assert.equal((await app.inject({ method, url: '/mcp/financial-data' })).statusCode, 401)
    assert.equal((await app.inject({
      method, url: '/mcp/financial-data', headers: { authorization: 'Bearer wrong-token' },
    })).statusCode, 401)
    assert.equal((await app.inject({
      method, url: '/mcp/financial-data',
      headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' },
    })).statusCode, 403)
  }
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await app.inject({
      method, url: '/mcp/financial-data', headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.allow, 'POST')
  }
  assert.equal(executions, 0)
})

test('真实 MCP 客户端发现 19 个只读工具，JSON Schema 与注册表一致', async (t) => {
  assert.deepEqual(financialDataToolDefinitions, registeredToolDefinitions.filter(
    (definition) => definition.externalNetwork === 'financial_data' && definition.sideEffect === 'read_only',
  ))
  const mcp = await startMcp()
  t.after(() => mcp.close())
  const client = await mcp.connect()
  assert.equal(client.getServerVersion()?.name, 'vibe-invest-financial-data')
  const tools = (await client.listTools()).tools
  assert.deepEqual(tools.map(({ name }) => name).sort(), expectedNames)
  for (const tool of tools) {
    const definition = financialDataToolDefinitions.find(({ model }) => model.name === tool.name)
    assert.ok(definition)
    assert.equal(tool.description, definition.model.description)
    assert.deepEqual(tool.inputSchema, JSON.parse(JSON.stringify(definition.model.parameters)))
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    })
    assert.equal(tool.outputSchema, undefined)
  }
})

test('真实 MCP 行情和财务调用保留来源、观测时间、取得时间和缺口', async (t) => {
  const quoteCalls: Array<{ symbols: string[]; force?: boolean }> = []
  const financialFact = {
    id: 'fact:NVDA:revenue', type: 'financial_metric', value: { revenue: 10_000, period: '2026Q2' },
    observedAt: '2026-08-28', fetchedAt: '2026-09-30T10:01:00Z',
    source: 'sec', sourceReference: 'https://www.sec.gov/filing',
  }
  const overview = { symbol: 'NVDA', latestPeriod: '2026Q2' }
  const mcp = await startMcp({
    fetchMarketQuotes: async (symbols, signal, options) => {
      assert.equal(signal.aborted, false)
      quoteCalls.push({ symbols, force: options?.force })
      return {
        snapshots: [
          { symbol: 'SPY', price: 701, previousClose: 700, observedAt: '2026-09-30T20:00:00Z', source: 'quote-source', degraded: false, sources: [] },
          { symbol: 'QQQ', price: null, observedAt: null, source: null, degraded: true, sources: [] },
        ],
        fetchedAt: Date.parse('2026-09-30T20:00:01Z'), cached: false,
      }
    },
    getFinancialOverview: async (symbol, signal) => {
      assert.equal(symbol, 'NVDA')
      assert.equal(signal.aborted, false)
      return { facts: [financialFact], overview, sources: [{ source: 'sec', status: 'ok' }] }
    },
  })
  t.after(() => mcp.close())
  const client = await mcp.connect()
  const quotes = await call(client, 'get_market_quotes', { symbols: ['spy', 'QQQ'] })
  assert.notEqual(quotes.response.isError, true)
  assert.deepEqual(quoteCalls, [{ symbols: ['SPY', 'QQQ'], force: true }])
  assert.deepEqual(quotes.value, {
    facts: [],
    quotes: [
      { symbol: 'SPY', price: 701, previousClose: 700, observedAt: '2026-09-30T20:00:00Z', source: 'quote-source', degraded: false, sources: [] },
      { symbol: 'QQQ', price: null, observedAt: null, source: null, degraded: true, sources: [] },
    ],
    gaps: [{ capability: 'quote', symbol: 'QQQ', reason: 'quote_unavailable' }],
    fetchedAt: '2026-09-30T20:00:01.000Z', cached: false,
  })
  const financial = await call(client, 'get_financial_overview', { symbol: 'nvda' })
  assert.notEqual(financial.response.isError, true)
  assert.deepEqual(financial.value, {
    facts: [financialFact], overview, sources: [{ source: 'sec', status: 'ok' }],
  })
})

test('两个独立 MCP 客户端共享新闻 fact，按 factId 和 evidenceId 读取正文', async (t) => {
  const reads: string[] = []
  const document = { ...news, id: 'fact:news-document:1', evidenceLevel: 'verified_news' }
  const mcp = await startMcp({
    searchNewsCandidates: async (query) => {
      assert.equal(query, 'NVDA product launch')
      return { facts: [news], sources: [{ source: 'news-source', status: 'ok' }] }
    },
    readNewsDocument: async (candidate) => {
      assert.deepEqual(candidate, news)
      reads.push(candidate.id)
      return { facts: [document], excerpt: 'Product launch confirmed.' }
    },
  })
  t.after(() => mcp.close())
  const searchClient = await mcp.connect()
  const search = await call(searchClient, 'search_news_candidates', { query: 'NVDA product launch' })
  const facts = search.value.facts as Array<{ id: string }>
  assert.equal(facts[0]?.id, news.id)
  await searchClient.close()
  const readClient = await mcp.connect()
  const read = await call(readClient, 'read_news_document', { factId: facts[0]!.id })
  assert.notEqual(read.response.isError, true)
  assert.deepEqual(read.value, { facts: [document], excerpt: 'Product launch confirmed.' })
  const evidence = await call(readClient, 'read_evidence', { evidenceId: facts[0]!.id })
  assert.notEqual(evidence.response.isError, true)
  assert.deepEqual(evidence.value, read.value)
  assert.deepEqual(reads, [news.id, news.id])
})

test('MCP 未知 fact、上游失败和非法行情参数返回错误，写账本工具不可调用', async (t) => {
  let quoteRequests = 0
  const mcp = await startMcp({
    readNewsDocument: async () => { throw new Error('must_not_read_unknown_fact') },
    fetchMarketQuotes: async () => {
      quoteRequests += 1
      throw new Error('financial_data_quotes_http_503')
    },
  })
  t.after(() => mcp.close())
  const client = await mcp.connect()
  for (const [name, args, error] of [
    ['read_news_document', { factId: 'fact:missing' }, 'news_candidate_not_found'],
    ['read_evidence', { evidenceId: 'fact:missing' }, 'evidence_not_found'],
    ['get_market_quotes', { symbols: ['SPY'] }, 'financial_data_quotes_http_503'],
    ['get_market_quotes', { symbols: ['invalid symbol'] }, 'quote_symbols_invalid'],
    ['record_portfolio_trade', {}, 'unknown_tool'],
  ] as const) {
    const failed = await call(client, name, args)
    assert.equal(failed.response.isError, true)
    assert.equal(failed.value.error, error)
    if (error !== 'unknown_tool') assert.deepEqual(failed.value.facts, [])
  }
  assert.equal(quoteRequests, 1)
})

test('共享 fact 存储默认最多 2000 条，按插入顺序淘汰且旧 fact 返回明确错误', async (t) => {
  const facts = Array.from({ length: 2001 }, (_, index) => ({ ...news, id: `fact:news:${index}` }))
  const mcp = await startMcp({
    searchNewsCandidates: async () => ({ facts }),
    readNewsDocument: async (candidate) => ({ facts: [candidate], excerpt: candidate.id }),
  })
  t.after(() => mcp.close())
  const searchClient = await mcp.connect()
  await call(searchClient, 'search_news_candidates', { query: 'batch' })
  await searchClient.close()
  const readClient = await mcp.connect()
  const evicted = await call(readClient, 'read_news_document', { factId: facts[0]!.id })
  assert.equal(evicted.response.isError, true)
  assert.equal(evicted.value.error, 'news_candidate_not_found')
  const retained = await call(readClient, 'read_news_document', { factId: facts[1]!.id })
  assert.notEqual(retained.response.isError, true)
  assert.equal(retained.value.excerpt, facts[1]!.id)
})
