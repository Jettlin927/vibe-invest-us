import assert from 'node:assert/strict'
import test from 'node:test'

import { createResearchToolExecutor } from '../src/research-capability.js'

const news = {
  id: 'fact:news:1', type: 'news', value: { title: 'Product launch' },
  observedAt: '2026-09-04T10:00:00Z', fetchedAt: '2026-09-04T10:01:00Z',
  source: 'news-source', sourceReference: 'https://example.com/news', evidenceLevel: 'title_only',
}
const filing = {
  id: 'fact:NVDA:official-event:0001', type: 'company_event',
  value: { symbol: 'NVDA', filingId: '0001', form: '8-K' },
  observedAt: '2026-09-04', fetchedAt: '2026-09-04T10:01:00Z',
  source: 'sec', sourceReference: 'https://www.sec.gov/filing',
  evidenceLevel: 'official_company_event',
}

test('自由研究统一搜索并按证据类型读取新闻正文或官方 Filing', async () => {
  const calls: string[] = []
  const knownFacts = new Map()
  const execute = createResearchToolExecutor({
    searchNewsCandidates: async (query) => {
      calls.push(`search:${query}`)
      return { facts: [news], sources: [{ source: 'news-source', status: 'ok' }], eligibility: {
        eligible: false, normalizedQuery: query, reasons: [
          { source: 'one', reason: 'qualified' },
          { source: 'two', reason: 'empty' },
          { source: 'three', reason: 'empty' },
        ],
      } }
    },
    listOfficialCompanyEvents: async (symbol) => {
      calls.push(`events:${symbol}`)
      return { facts: [filing], sources: [{ source: 'sec', status: 'ok' }] }
    },
    readNewsDocument: async (candidate) => {
      calls.push(`news-document:${candidate.id}`)
      return { facts: [{ ...news, id: 'fact:news-document:1', evidenceLevel: 'verified_news' }] }
    },
    readFilingDocument: async (symbol, filingId, cursor) => {
      calls.push(`filing:${symbol}:${filingId}:${cursor ?? ''}`)
      return {
        facts: [{ ...filing, id: 'fact:filing-page:1', evidenceLevel: 'official_filing' }],
        returnedCount: 100, totalCount: 200, nextCursor: '100', truncated: true,
      }
    },
  })({ threadId: 'thread-1', knownFacts })
  const signal = new AbortController().signal

  const search = await execute(
    'search_evidence', { query: 'NVDA event', symbol: 'NVDA' }, signal, async () => {},
  )
  assert.deepEqual((search.result.facts as Array<{ id: string }>).map(({ id }) => id), [
    news.id, filing.id,
  ])
  assert.deepEqual(search.result.sources, [
    { source: 'news-source', status: 'ok' }, { source: 'sec', status: 'ok' },
  ])

  const newsDocument = await execute(
    'read_evidence', { evidenceId: news.id }, signal, async () => {},
  )
  assert.equal((newsDocument.result.facts as Array<{ evidenceLevel: string }>)[0]?.evidenceLevel, 'verified_news')
  const filingDocument = await execute(
    'read_evidence', { evidenceId: filing.id, cursor: '0' }, signal, async () => {},
  )
  assert.equal(filingDocument.result.nextCursor, '100')
  assert.deepEqual(calls, [
    'search:NVDA event', 'events:NVDA',
    `news-document:${news.id}`, 'filing:NVDA:0001:0',
  ])
})

test('自由研究公司档案按部分独立降级且市场结构由宿主确定性计算', async () => {
  const knownFacts = new Map()
  const financialFact = { ...filing, id: 'fact:financial:1', type: 'reported_financial' }
  const technicalFact = { ...filing, id: 'fact:technical:1', type: 'technical_analysis' }
  const execute = createResearchToolExecutor({
    getFinancialOverview: async () => ({
      facts: [financialFact], overview: { symbol: 'NVDA', latestPeriod: 'CY2026Q2' },
      sources: [{ source: 'sec', status: 'ok' }],
    }),
    getValuationEvidence: async () => { throw new Error('valuation_unavailable') },
    listOfficialCompanyEvents: async () => ({ facts: [filing], sources: [] }),
    getTechnicalEvidence: async () => ({
      facts: [technicalFact], symbol: 'NVDA', actualStart: '2025-09-04', actualEnd: '2026-09-04',
      totalBarCount: 252, structures: {}, indicators: {}, volatility: {}, drawdown: {},
      volumePrice: {}, keyLevels: {}, conflicts: [],
    }),
  })({ threadId: 'thread-2', knownFacts })
  const signal = new AbortController().signal

  const dossier = await execute(
    'get_company_dossier', { symbol: 'NVDA' }, signal, async () => {},
  )
  assert.equal((dossier.result.overview as { latestPeriod: string }).latestPeriod, 'CY2026Q2')
  assert.deepEqual((dossier.result.facts as Array<{ id: string }>).map(({ id }) => id), [
    financialFact.id, filing.id,
  ])
  assert.deepEqual(dossier.result.gaps, [{
    capability: 'valuation', reason: 'valuation_unavailable',
  }])

  const structure = await execute(
    'get_market_structure', { symbol: 'NVDA' }, signal, async () => {},
  )
  assert.equal(structure.result.totalBarCount, 252)
  assert.equal(knownFacts.has(technicalFact.id), true)
})

test('自由研究提供紧凑起始资料、同口径标的比较和私有组合聚合', async () => {
  const knownFacts = new Map()
  const execute = createResearchToolExecutor({
    fetchFinancialContext: async (symbol) => ({
      symbol, facts: [{ ...news, id: `fact:${symbol}:context` }], gaps: [],
    }),
    getFinancialOverview: async (symbol) => ({
      facts: [{ ...news, id: `fact:${symbol}:financial` }],
      overview: { symbol, latestPeriod: 'CY2026Q2', qualityFlags: [] }, sources: [],
    }),
    getValuationEvidence: async (symbol) => ({
      facts: [{ ...news, id: `fact:${symbol}:valuation` }], symbol,
      currentMultiples: { pe: symbol === 'NVDA' ? 30 : 20 }, methods: {},
      authorizedComparables: [], comparables: [], historicalRanges: {},
      privateDiagnostic: '不得进入自由研究结果',
    }),
    getTechnicalEvidence: async (symbol) => {
      if (symbol === 'AMD') throw new Error('technical_unavailable')
      return {
        facts: [{ ...news, id: `fact:${symbol}:technical` }], symbol,
        structures: { '20d': { status: 'up' } }, indicators: { rsi14: 55 },
        volatility: {}, drawdown: {}, volumePrice: {}, keyLevels: {}, conflicts: [],
        providerEnvelope: { secret: '不得进入自由研究结果' },
      }
    },
    listPortfolioSymbols: async () => ['NVDA', 'AMD'],
    fetchMarketPrices: async (symbols) => Object.fromEntries(symbols.map((item) => [item, 100])),
    getPortfolioContext: async (symbol, prices) => ({
      position: { symbol, quantity: 2, marketPrice: prices[symbol], portfolioWeight: 0.4 },
      portfolio: { totalMarketValue: 500, positionCount: 2 },
    }),
  })({ threadId: 'thread-3', knownFacts })
  const signal = new AbortController().signal

  const context = await execute(
    'get_research_context', { symbol: 'NVDA' }, signal, async () => {},
  )
  assert.equal(context.result.symbol, 'NVDA')

  const comparison = await execute(
    'compare_securities', { symbols: ['nvda', 'AMD'] }, signal, async () => {},
  )
  assert.deepEqual((comparison.result.comparisons as Array<{ symbol: string }>).map(({ symbol }) => symbol), [
    'NVDA', 'AMD',
  ])
  assert.equal((comparison.result.comparisons as Array<any>)[0]?.currentMultiples.pe, 30)
  assert.doesNotMatch(JSON.stringify(comparison.result), /privateDiagnostic|providerEnvelope|不得进入/)
  assert.deepEqual(comparison.result.gaps, [{
    capability: 'market_structure', symbol: 'AMD', reason: 'technical_unavailable',
  }])

  const exposure = await execute(
    'get_portfolio_exposure', { symbol: 'NVDA' }, signal, async () => {},
  )
  assert.deepEqual(exposure.result.position, {
    symbol: 'NVDA', quantity: 2, marketPrice: 100, portfolioWeight: 0.4,
  })
  assert.deepEqual(exposure.result.portfolio, { totalMarketValue: 500, positionCount: 2 })
})
