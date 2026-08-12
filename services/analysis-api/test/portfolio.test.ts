import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'

const healthyFinancialData = async () => ({
  service: 'financial-data' as const,
  status: 'ok' as const,
})

const testDatabases = new Map<string, ReturnType<typeof createTestProductDatabase>>()

function productDatabaseFor(databasePath: string) {
  const existing = testDatabases.get(databasePath)
  if (existing) return existing
  const created = createTestProductDatabase()
  testDatabases.set(databasePath, created)
  return created
}

async function createTestApp(databasePath: string) {
  const app = buildApp({
    databasePath, ...productDatabaseFor(databasePath), financialDataHealth: healthyFinancialData,
  })
  await app.ready()
  return app
}

async function createPricedTestApp(databasePath: string, prices: Record<string, number>) {
  const app = buildApp({
    databasePath,
    ...productDatabaseFor(databasePath),
    financialDataHealth: healthyFinancialData,
    fetchMarketPrices: async (symbols) => Object.fromEntries(
      symbols.flatMap((symbol) => prices[symbol] === undefined ? [] : [[symbol, prices[symbol]]]),
    ),
  })
  await app.ready()
  return app
}

async function createHistoricalTestApp(databasePath: string, prices: Record<string, number>, now: () => Date) {
  const app = buildApp({
    databasePath,
    ...productDatabaseFor(databasePath),
    financialDataHealth: healthyFinancialData,
    fetchMarketPrices: async (symbols) => Object.fromEntries(
      symbols.flatMap((symbol) => prices[symbol] === undefined ? [] : [[symbol, prices[symbol]]]),
    ),
    now,
  })
  await app.ready()
  return app
}

test('用户可以新增、修改、查看和删除手工持仓', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-portfolio-'))
  const app = await createTestApp(join(dataDir, 'app.db'))

  const created = await app.inject({
    method: 'PUT',
    url: '/api/positions/NVDA',
    payload: { quantity: 10, averageCost: 100 },
  })
  assert.equal(created.statusCode, 200)

  const updated = await app.inject({
    method: 'PUT',
    url: '/api/positions/nvda',
    payload: { quantity: 12, averageCost: 105 },
  })
  assert.equal(updated.statusCode, 200)

  const listed = await app.inject({ method: 'GET', url: '/api/positions' })
  assert.deepEqual(listed.json(), {
    positions: [{ symbol: 'NVDA', quantity: 12, averageCost: 105 }],
  })

  const removed = await app.inject({ method: 'DELETE', url: '/api/positions/NVDA' })
  assert.equal(removed.statusCode, 204)
  assert.deepEqual(
    (await app.inject({ method: 'GET', url: '/api/positions' })).json(),
    { positions: [] },
  )

  await app.close()
})

test('用户可以维护现金并查看组合总值、仓位和未实现盈亏', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-overview-'))
  const app = await createPricedTestApp(join(dataDir, 'app.db'), { NVDA: 120, MSFT: 180 })
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 10, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/positions/MSFT', payload: { quantity: 5, averageCost: 200 } })

  const cash = await app.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: 500 } })
  assert.equal(cash.statusCode, 200)
  assert.deepEqual(cash.json(), { cash: 500 })

  const response = await app.inject({ method: 'GET', url: '/api/portfolio' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    cash: 500,
    totalCost: 2000,
    totalMarketValue: 2100,
    totalEquity: 2600,
    totalUnrealizedProfitLoss: 100,
    totalUnrealizedReturn: 0.05,
    pricedPositionCount: 2,
    unpricedPositionCount: 0,
    positions: [
      { symbol: 'MSFT', quantity: 5, averageCost: 200, costAmount: 1000, marketPrice: 180, marketValue: 900, unrealizedProfitLoss: -100, unrealizedReturn: -0.1, portfolioWeight: 900 / 2600 },
      { symbol: 'NVDA', quantity: 10, averageCost: 100, costAmount: 1000, marketPrice: 120, marketValue: 1200, unrealizedProfitLoss: 200, unrealizedReturn: 0.2, portfolioWeight: 1200 / 2600 },
    ],
  })
  await app.close()
})

test('减仓按成交价增加现金并保留平均成本', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-reduce-'))
  const app = await createPricedTestApp(join(dataDir, 'app.db'), { NVDA: 120 })
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 10, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: 500 } })

  const reduced = await app.inject({
    method: 'POST', url: '/api/positions/NVDA/reduce', payload: { quantity: 4, price: 125 },
  })
  assert.equal(reduced.statusCode, 200)
  assert.deepEqual(reduced.json(), {
    position: { symbol: 'NVDA', quantity: 6, averageCost: 100 },
    cash: 1000,
    proceeds: 500,
    realizedProfitLoss: 100,
  })
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/positions' })).json(), {
    positions: [{ symbol: 'NVDA', quantity: 6, averageCost: 100 }],
  })
  await app.close()
})

test('组合行情形成每日权益快照，同日盘中覆盖且收盘快照不被盘中值回退', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-history-'))
  const databasePath = join(dataDir, 'app.db')
  const prices = { NVDA: 110 }
  let observedAt = new Date('2026-08-11T19:00:00Z')
  const app = await createHistoricalTestApp(databasePath, prices, () => observedAt)
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 10, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: 100 } })
  await app.inject({ method: 'GET', url: '/api/portfolio' })

  prices.NVDA = 120
  observedAt = new Date('2026-08-11T20:05:00Z')
  await app.inject({ method: 'GET', url: '/api/portfolio' })
  prices.NVDA = 90
  observedAt = new Date('2026-08-11T19:30:00Z')
  await app.inject({ method: 'GET', url: '/api/portfolio' })

  prices.NVDA = 125
  observedAt = new Date('2026-08-12T15:00:00Z')
  await app.inject({ method: 'GET', url: '/api/portfolio' })

  const history = (await app.inject({ method: 'GET', url: '/api/portfolio/history?limit=30' })).json()
  assert.equal(history.currency, 'USD')
  assert.deepEqual(history.snapshots, [
    {
      marketDay: '2026-08-12', totalEquity: 1350, totalMarketValue: 1250, cash: 100,
      holdingsCount: 1, pricedCount: 1, observedAt: '2026-08-12T15:00:00.000Z', afterClose: false,
      dailyChange: 50, dailyReturn: 50 / 1300,
    },
    {
      marketDay: '2026-08-11', totalEquity: 1300, totalMarketValue: 1200, cash: 100,
      holdingsCount: 1, pricedCount: 1, observedAt: '2026-08-11T20:05:00.000Z', afterClose: true,
      dailyChange: null, dailyReturn: null,
    },
  ])
  await app.close()
})

test('减仓数量不能超过当前持仓且现金不能为负数', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-reduce-invalid-'))
  const app = await createTestApp(join(dataDir, 'app.db'))
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 2, averageCost: 100 } })
  assert.equal((await app.inject({ method: 'POST', url: '/api/positions/NVDA/reduce', payload: { quantity: 3, price: 120 } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/portfolio/cash', payload: { cash: -1 } })).statusCode, 400)
  await app.close()
})

test('持仓语境计算市值盈亏和组合集中度且不返回其他持仓明细', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-context-'))
  const app = await createTestApp(join(dataDir, 'app.db'))
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 10, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/positions/MSFT', payload: { quantity: 5, averageCost: 200 } })

  const response = await app.inject({
    method: 'POST',
    url: '/api/portfolio-context',
    payload: { symbol: 'NVDA', marketPrices: { NVDA: 120, MSFT: 240 } },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    position: {
      symbol: 'NVDA',
      quantity: 10,
      averageCost: 100,
      marketPrice: 120,
      marketValue: 1200,
      unrealizedProfitLoss: 200,
      portfolioWeight: 0.5,
    },
    portfolio: {
      totalMarketValue: 2400,
      largestPositionWeight: 0.5,
      topThreeWeight: 1,
      positionCount: 2,
      pricedPositionCount: 2,
      unpricedPositionCount: 0,
    },
  })
  assert.doesNotMatch(response.body, /MSFT/)

  await app.close()
})

test('没有当前标的持仓时返回公共分析语境', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-no-position-'))
  const app = await createTestApp(join(dataDir, 'app.db'))

  const response = await app.inject({
    method: 'POST',
    url: '/api/portfolio-context',
    payload: { symbol: 'AAPL', marketPrices: {} },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    position: null,
    portfolio: {
      totalMarketValue: 0,
      largestPositionWeight: 0,
      topThreeWeight: 0,
      positionCount: 0,
      pricedPositionCount: 0,
      unpricedPositionCount: 0,
    },
  })

  await app.close()
})

test('部分持仓缺少行情时不伪造组合权重或集中度', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-partial-prices-'))
  const app = await createTestApp(join(dataDir, 'app.db'))
  await app.inject({ method: 'PUT', url: '/api/positions/NVDA', payload: { quantity: 10, averageCost: 100 } })
  await app.inject({ method: 'PUT', url: '/api/positions/MSFT', payload: { quantity: 5, averageCost: 200 } })
  const response = await app.inject({
    method: 'POST', url: '/api/portfolio-context',
    payload: { symbol: 'NVDA', marketPrices: { NVDA: 120 } },
  })
  assert.deepEqual(response.json().position.portfolioWeight, null)
  assert.deepEqual(response.json().portfolio, {
    totalMarketValue: null, largestPositionWeight: null, topThreeWeight: null,
    positionCount: 2, pricedPositionCount: 1, unpricedPositionCount: 1,
  })
  await app.close()
})

test('持仓在 Analysis API 重新打开数据库后仍然存在', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-persistence-'))
  const databasePath = join(dataDir, 'app.db')
  const firstApp = await createTestApp(databasePath)
  await firstApp.inject({ method: 'PUT', url: '/api/positions/AMD', payload: { quantity: 8, averageCost: 90 } })
  await firstApp.close()

  const secondApp = await createTestApp(databasePath)
  const response = await secondApp.inject({ method: 'GET', url: '/api/positions' })
  assert.deepEqual(response.json(), {
    positions: [{ symbol: 'AMD', quantity: 8, averageCost: 90 }],
  })
  await secondApp.close()
})

test('持仓接口拒绝无效数量和成本', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-validation-'))
  const app = await createTestApp(join(dataDir, 'app.db'))

  const response = await app.inject({
    method: 'PUT',
    url: '/api/positions/NVDA',
    payload: { quantity: 0, averageCost: -1 },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'invalid_position' })
  await app.close()
})
