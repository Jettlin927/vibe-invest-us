import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkSchema,
  createPool,
  createPortfolioRepository,
} from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/database.js'
import type { ModelEvent } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL

function createPostgresApp(databasePath: string, now?: () => Date) {
  const pool = createPool(databaseUrl!)
  return buildApp({
    databasePath,
    productDatabase: {
      checkSchema: () => checkSchema(pool),
      close: () => pool.end(),
    },
    portfolioRepository: createPortfolioRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchMarketPrices: async (symbols) => Object.fromEntries(
      symbols.map((symbol) => [symbol, symbol === 'NVDA' ? 120 : 240]),
    ),
    now,
  })
}

test('真实 PostgreSQL HTTP 持仓闭环持久化且不双写 SQLite', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-real-pg-portfolio-'))
  const sqlitePath = join(dataDir, 'research.db')
  const cleanupPool = createPool(databaseUrl!)
  await cleanupPool.query('DELETE FROM portfolio_equity_snapshots')
  await cleanupPool.query('DELETE FROM positions')
  await cleanupPool.query('UPDATE portfolio_settings SET cash = 0 WHERE id = 1')
  await cleanupPool.end()

  let observedAt = new Date('2026-08-11T19:00:00Z')
  const first = createPostgresApp(sqlitePath, () => observedAt)
  await first.ready()
  await first.inject({
    method: 'PUT', url: '/api/positions/NVDA',
    payload: { quantity: 10.125, averageCost: 100.25 },
  })
  await first.inject({
    method: 'PUT', url: '/api/positions/MSFT',
    payload: { quantity: 5, averageCost: 200 },
  })
  await first.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: 500.5 } })
  const reduced = await first.inject({
    method: 'POST', url: '/api/positions/NVDA/reduce',
    payload: { quantity: 0.125, price: 125.5 },
  })
  assert.deepEqual(reduced.json(), {
    position: { symbol: 'NVDA', quantity: 10, averageCost: 100.25 },
    cash: 516.1875,
    proceeds: 15.6875,
    realizedProfitLoss: 3.15625,
  })
  await first.inject({ method: 'GET', url: '/api/portfolio' })
  observedAt = new Date('2026-08-11T20:05:00Z')
  await first.inject({ method: 'GET', url: '/api/portfolio' })
  await first.close()

  const second = createPostgresApp(sqlitePath)
  await second.ready()
  assert.deepEqual((await second.inject({ method: 'GET', url: '/api/positions' })).json(), {
    positions: [
      { symbol: 'MSFT', quantity: 5, averageCost: 200 },
      { symbol: 'NVDA', quantity: 10, averageCost: 100.25 },
    ],
  })
  const history = (await second.inject({
    method: 'GET', url: '/api/portfolio/history?limit=30',
  })).json()
  assert.equal(history.snapshots.length, 1)
  assert.equal(history.snapshots[0].marketDay, '2026-08-11')
  assert.equal(history.snapshots[0].afterClose, true)

  const context = await second.inject({
    method: 'POST', url: '/api/portfolio-context',
    payload: { symbol: 'NVDA', marketPrices: { NVDA: 120, MSFT: 240 } },
  })
  assert.equal(context.json().position.symbol, 'NVDA')
  assert.doesNotMatch(context.body, /MSFT/)
  await second.close()

  let capturedPortfolioContext: unknown
  const analysisPool = createPool(databaseUrl!)
  const analysis = buildApp({
    databasePath: sqlitePath,
    productDatabase: {
      checkSchema: () => checkSchema(analysisPool),
      close: () => analysisPool.end(),
    },
    portfolioRepository: createPortfolioRepository(analysisPool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, gaps: [], facts: [{
        id: 'fact:NVDA:quote:test', type: 'quote', value: 120,
        observedAt: '2026-08-13T00:00:00Z', fetchedAt: '2026-08-13T00:00:01Z',
        source: 'test', sourceReference: 'https://example.com/NVDA',
      }],
    }),
    fetchMarketPrices: async () => ({ NVDA: 120, MSFT: 240 }),
    model: {
      async *analyze({ fetchFinancialContext }: {
        fetchFinancialContext: () => Promise<{ portfolioContext: unknown }>
      }): AsyncGenerator<ModelEvent> {
        capturedPortfolioContext = (await fetchFinancialContext()).portfolioContext
        yield { type: 'completed', report: {
          title: '测试报告', marketState: '稳定', trend: '震荡', drivers: ['量价'],
          supportingEvidence: ['fact:NVDA:quote:test'], contraryEvidence: ['fact:NVDA:quote:test'],
          keyJudgments: [{ judgment: '震荡', evidence: ['fact:NVDA:quote:test'] }],
          scenarios: [{ name: '基准', condition: '维持', outcome: '震荡' }],
          invalidationConditions: ['跌破'], valuation: null, personalImpact: '条件影响',
          conditionalSuggestion: '条件建议', limitations: [],
        } }
      },
    },
  })
  await analysis.ready()
  const created = (await analysis.inject({
    method: 'POST', url: '/api/analyses', payload: { symbol: 'NVDA' },
  })).json() as { analysisId: string }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = (await analysis.inject({
      method: 'GET', url: `/api/analyses/${created.analysisId}`,
    })).json() as { status: string }
    if (status.status === 'completed') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal((capturedPortfolioContext as { position: { symbol: string } }).position.symbol, 'NVDA')
  assert.doesNotMatch(JSON.stringify(capturedPortfolioContext), /MSFT/)
  await analysis.close()

  const sqlite = openDatabase(sqlitePath)
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM positions').get() as { count: number }).count, 0)
  assert.equal((sqlite.prepare('SELECT cash FROM portfolio_settings WHERE id = 1').get() as { cash: number }).cash, 0)
  sqlite.close()
})
