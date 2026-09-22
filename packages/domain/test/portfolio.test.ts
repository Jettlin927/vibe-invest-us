import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateBuy, calculateSell, calculatePortfolioOverview, calculatePortfolioContext } from '../src/portfolio.js'

test('买卖规则独立计算成本、现金与已实现盈亏，拒绝不足的现金和持仓', () => {
  const position = { symbol: 'TEST', quantity: 10, averageCost: 20 }
  assert.equal(calculateBuy(position, 9, 'TEST', 1, 10), null)
  const buy = calculateBuy(position, 100, 'TEST', 10, 10)!
  assert.deepEqual(buy, { position: { symbol: 'TEST', quantity: 20, averageCost: 15 }, cash: 0, spent: 100 })
  const sell = calculateSell(buy.position, buy.cash, 5, 25)!
  assert.deepEqual(sell, {
    position: { symbol: 'TEST', quantity: 15, averageCost: 15 }, cash: 125,
    proceeds: 125, realizedProfitLoss: 50,
  })
  assert.equal(calculateSell(sell.position, sell.cash, 16, 25), null)
  assert.equal(calculateSell(sell.position, sell.cash, 15, 25)!.position, null)
  assert.deepEqual(position, { symbol: 'TEST', quantity: 10, averageCost: 20 })
})

test('行情不齐时保留缺口，当前标的语境不泄露其他持仓明细', () => {
  const positions = [
    { symbol: 'AAA', quantity: 10, averageCost: 20 },
    { symbol: 'BBB', quantity: 5, averageCost: 10 },
  ]
  const partial = calculatePortfolioOverview(positions, 50, { AAA: 30 })
  assert.equal(partial.totalEquity, null)
  assert.equal(partial.unpricedPositionCount, 1)
  assert.equal(partial.positions[0]!.portfolioWeight, null)
  const complete = calculatePortfolioOverview(positions, 50, { AAA: 30, BBB: 20 })
  assert.equal(complete.totalEquity, 450)
  assert.equal(complete.totalUnrealizedProfitLoss, 150)
  const context = calculatePortfolioContext(positions, 'AAA', { AAA: 30 })
  assert.equal(context.position!.symbol, 'AAA')
  assert.equal(context.portfolio.totalMarketValue, null)
  assert.equal(JSON.stringify(context).includes('BBB'), false)
})
