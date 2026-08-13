import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'

import { createFinancialDataClient } from '../src/financial-data-client.js'

test('OpenAPI 定义 Financial Data 健康契约', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../../contracts/market-data/openapi.json', import.meta.url), 'utf8'),
  )

  assert.equal(contract.openapi, '3.1.0')
  assert.ok(contract.paths['/health'].get.responses['200'])
  assert.deepEqual(
    contract.components.schemas.HealthResponse.required,
    ['service', 'status'],
  )
})

test('TS 客户端通过 HTTP 读取符合契约的健康状态', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ service: 'financial-data', status: 'ok' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)

  await assert.doesNotReject(async () => {
    assert.deepEqual(await client.health(), { service: 'financial-data', status: 'ok' })
  })

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('TS 客户端拒绝不符合契约的响应', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)
  await assert.rejects(client.health(), /financial_data_contract_invalid/)

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('TS 客户端拒绝缺少来源或时间的金融事实', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ symbol: 'NVDA', facts: [{ id: 'fact-1', type: 'quote', value: 100 }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)
  await assert.rejects(() => client.context('NVDA'), /financial_context_contract_invalid/)
  server.close()
})

test('TS 客户端查询关键词新闻和日期范围技术指标', async () => {
  const requests: string[] = []
  const resultFact = {
    id: 'fact:query:1', type: 'indicators', value: { ma_20: 100 },
    observedAt: '2026-08-12', fetchedAt: '2026-08-12T12:00:00Z',
    source: 'deterministic-calculation', sourceReference: 'source://history',
  }
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ facts: [resultFact], sources: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)

  assert.equal((await client.searchNews('NAND pricing')).facts[0]?.id, resultFact.id)
  assert.equal((await client.searchWeb('NVDA event')).facts[0]?.id, resultFact.id)
  assert.equal((await client.technicalIndicators('SNDK', '2026-01-01', '2026-08-12')).facts[0]?.id, resultFact.id)
  assert.match(requests[0] ?? '', /keyword=NAND(?:\+|%20)pricing/)
  assert.match(requests[1] ?? '', /web-search.*query=NVDA(?:\+|%20)event/)
  assert.match(requests[2] ?? '', /symbol=SNDK.*start_date=2026-01-01.*end_date=2026-08-12/)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('TS 客户端只把已知 title_only 候选交给受限新闻文档端点', async () => {
  let body: unknown
  const candidate = {
    id: 'fact:news:candidate', type: 'news',
    value: { title: 'Event', summary: 'Lead', url: 'https://example.com/event' },
    observedAt: '2026-08-12T12:00:00Z', fetchedAt: '2026-08-12T12:01:00Z',
    source: 'google-news', sourceReference: 'https://example.com/event',
    evidenceLevel: 'title_only',
  }
  const document = {
    ...candidate, id: 'fact:news:document', type: 'news_document', evidenceLevel: 'verified_news',
    value: { excerpt: 'bounded', summary: 'bounded', contentHash: 'a'.repeat(64), metadata: {} },
  }
  const server = createServer(async (request, response) => {
    body = await new Promise((resolve) => {
      let text = ''
      request.on('data', (chunk) => { text += chunk })
      request.on('end', () => resolve(JSON.parse(text)))
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ facts: [document], sources: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)
  const result = await client.readNewsDocument(candidate)

  assert.deepEqual(body, { candidate })
  assert.equal(result.facts[0]?.evidenceLevel, 'verified_news')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('TS 客户端读取基本面高层工具并完整保留分页元数据', async (t) => {
  const requests: string[] = []
  const fact = {
    id: 'fact:NVDA:financial:1', type: 'reported_financial', value: { period: '2026-Q2' },
    observedAt: '2026-07-31', fetchedAt: '2026-08-13T00:00:00Z', source: 'sec',
    sourceReference: 'https://www.sec.gov/Archives/example', evidenceLevel: 'reported_financial',
  }
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url?.includes('valuation-evidence')
      ? { symbol: 'NVDA', authorizedComparables: ['AMD', 'AVGO', 'QCOM'],
          comparables: [{ symbol: 'AMD', pe: 28 }],
          currentMultiples: { pe: 30 }, historicalRanges: { pe: [18, 34] },
          methods: { dcf: { status: 'unavailable', reason: 'not_implemented' } },
          facts: [fact], sources: [] }
      : request.url?.includes('financial-overview')
      ? { overview: { symbol: 'NVDA', latestPeriod: '2026-Q2' }, facts: [fact], sources: [] }
      : request.url?.includes('filing-document')
        ? { items: [{ name: 'guidance', summary: 'Raised.' }], facts: [fact], sources: [],
            returnedCount: 1, totalCount: 3, nextCursor: '2', truncated: true }
        : { facts: [fact], sources: [], returnedCount: 1, totalCount: 4, nextCursor: '3', truncated: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve(),
  )))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = createFinancialDataClient(`http://127.0.0.1:${address.port}`)

  assert.equal((await client.financialOverview('NVDA')).overview.latestPeriod, '2026-Q2')
  assert.deepEqual(await client.financialMetricSeries('NVDA', 'revenue_yoy', '2'), {
    facts: [fact], sources: [], returnedCount: 1, totalCount: 4, nextCursor: '3', truncated: true,
  })
  assert.equal((await client.filingDocument('NVDA', '0001', '1')).items[0]?.name, 'guidance')
  assert.deepEqual(await client.officialCompanyEvents('NVDA'), { facts: [fact], sources: [] })
  assert.deepEqual(await client.valuationEvidence('NVDA'), {
    symbol: 'NVDA', authorizedComparables: ['AMD', 'AVGO', 'QCOM'],
    comparables: [{ symbol: 'AMD', pe: 28 }],
    currentMultiples: { pe: 30 }, historicalRanges: { pe: [18, 34] },
    methods: { dcf: { status: 'unavailable', reason: 'not_implemented' } },
    facts: [fact], sources: [],
  })
  assert.match(requests.join('\n'), /financial-metric-series.*metric=revenue_yoy.*cursor=2/)
  assert.match(requests.join('\n'), /filing-document.*filing_id=0001.*cursor=1/)
  assert.match(requests.join('\n'), /official-company-events.*symbol=NVDA/)
  assert.match(requests.join('\n'), /valuation-evidence.*symbol=NVDA/)
})
