import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkSchema,
  createAgentEventRepository,
  createAnalysisRepository,
  createPool,
  createPortfolioRepository,
  createRuntimeSettingsRepository,
  createToolProjectionRepository,
} from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import type { ModelEvent } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL

function createPostgresApp(now?: () => Date) {
  const pool = createPool(databaseUrl!)
  return buildApp({
    productDatabase: {
      checkSchema: () => checkSchema(pool),
      close: () => pool.end(),
    },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: createAgentEventRepository(pool),
    runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchMarketPrices: async (symbols) => Object.fromEntries(
      symbols.map((symbol) => [symbol, symbol === 'NVDA' ? 120 : 240]),
    ),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: { async *analyze(): AsyncGenerator<ModelEvent> { return } },
    migrationVerificationToken: 'real-pg-verification-token',
    now,
  })
}

test('真实 PostgreSQL HTTP 持仓与研究闭环在重启后持久化', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const cleanupPool = createPool(databaseUrl!)
  await cleanupPool.query('DELETE FROM analyses')
  await cleanupPool.query('DELETE FROM portfolio_equity_snapshots')
  await cleanupPool.query('DELETE FROM positions')
  await cleanupPool.query('UPDATE portfolio_settings SET cash = 0 WHERE id = 1')
  await cleanupPool.end()

  let observedAt = new Date('2026-08-11T19:00:00Z')
  const first = createPostgresApp(() => observedAt)
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

  const second = createPostgresApp()
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
    productDatabase: {
      checkSchema: () => checkSchema(analysisPool),
      close: () => analysisPool.end(),
    },
    portfolioRepository: createPortfolioRepository(analysisPool),
    analysisRepository: createAnalysisRepository(analysisPool),
    agentEventRepository: createAgentEventRepository(analysisPool),
    runtimeSettingsRepository: createRuntimeSettingsRepository(analysisPool),
    toolProjectionRepository: createToolProjectionRepository(analysisPool),
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

  const readback = createPostgresApp()
  await readback.ready()
  const research = await readback.inject({ method: 'GET', url: `/api/research/${created.analysisId}` })
  assert.equal(research.statusCode, 200)
  assert.equal(research.json().report.title, '测试报告')
  assert.ok(research.json().trace.length > 0)
  await readback.close()
})

test('迁移验证 API 保留 PostgreSQL decimal 文本精度且默认受令牌保护', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  await pool.query('DELETE FROM positions WHERE symbol = $1', ['DECIMAL'])
  await pool.query(
    `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
     VALUES ($1, $2, $3, $4)`,
    ['DECIMAL', '0.123456789012345678901', '9876543210.1234567890123456789', '2026-08-13T00:00:00Z'],
  )
  await pool.end()
  const app = createPostgresApp()
  await app.ready()
  assert.equal((await app.inject({ method: 'GET', url: '/api/migration-verification' })).statusCode, 404)
  const response = await app.inject({
    method: 'GET', url: '/api/migration-verification',
    headers: { authorization: 'Bearer real-pg-verification-token' },
  })
  const decimal = response.json().positions.find((position: { symbol: string }) => position.symbol === 'DECIMAL')
  assert.deepEqual(decimal, {
    symbol: 'DECIMAL',
    quantity: '0.123456789012345678901',
    averageCost: '9876543210.1234567890123456789',
  })
  await app.close()
})

test('真实 PostgreSQL Settings HTTP 保存 revision、冻结 execution 并恢复默认值', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const cleanup = createPool(databaseUrl!)
  await cleanup.query("DELETE FROM analyses WHERE symbol = 'PGSET'")
  await cleanup.end()
  const app = createPostgresApp()
  await app.ready()
  try {
    await app.inject({ method: 'POST', url: '/api/settings/defaults' })
    const changed = await app.inject({
      method: 'PUT', url: '/api/settings',
      payload: { mainAgentToolRounds: 100, modelRequestTimeoutMinutes: 60 },
    })
    assert.equal(changed.statusCode, 200)
    const created = (await app.inject({
      method: 'POST', url: '/api/analyses', payload: { symbol: 'PGSET' },
    })).json() as { analysisId: string; executionId: string }
    await app.inject({
      method: 'PUT', url: '/api/settings', payload: { mainAgentToolRounds: 200 },
    })

    const readback = (await app.inject({ method: 'GET', url: '/api/settings' })).json()
    assert.equal(readback.current.values.mainAgentToolRounds, 200)
    const frozen = readback.activeExecutions.find((snapshot: { executionId: string }) => (
      snapshot.executionId === created.executionId
    ))
    assert.equal(frozen.values.mainAgentToolRounds, 100)
    assert.equal(frozen.values.modelRequestTimeoutMinutes, 60)

    const restored = await app.inject({ method: 'POST', url: '/api/settings/defaults' })
    assert.equal(restored.json().values.mainAgentToolRounds, 20)
    assert.equal(restored.json().values.modelRequestTimeoutMinutes, 15)
  } finally {
    await app.close()
  }
})
