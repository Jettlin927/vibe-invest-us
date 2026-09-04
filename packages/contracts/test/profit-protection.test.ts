import assert from 'node:assert/strict'
import test from 'node:test'

import { isProfitProtectionOverview } from '../src/index.js'

const validOverview = {
  summary: { planned: 1, triggered: 1, reviewRequired: 0, dataGap: 0 },
  positions: [{
    symbol: 'CRDO', status: 'triggered', planRevision: 1,
    currentR: 2, bindingRule: 'first_take_profit',
    nextRule: { kind: 'second_take_profit', atR: 3 },
    coreRatio: 0.6, tradingRatio: 0.4,
    anchorPrice: 180, invalidationPrice: 162, maxPortfolioWeight: 0.1,
    marketPrice: 216, portfolioWeight: 0.08,
    levels: { firstTakeProfit: 216, secondTakeProfit: 234, trailingStart: 252 },
  }],
  triggers: [{
    id: 'trigger-1', symbol: 'CRDO', rule: 'first_take_profit', status: 'open',
    triggeredAt: '2026-09-04T20:00:00.000Z', acknowledgedAt: null,
  }],
}

test('盈利保护公开契约接受完整响应并拒绝未知规则', () => {
  assert.equal(isProfitProtectionOverview(validOverview), true)
  assert.equal(isProfitProtectionOverview({
    ...validOverview,
    positions: [{ ...validOverview.positions[0], bindingRule: 'model_guess' }],
  }), false)
  assert.equal(isProfitProtectionOverview({
    ...validOverview,
    triggers: [{ ...validOverview.triggers[0], rule: 'model_guess' }],
  }), false)
  assert.equal(isProfitProtectionOverview({
    ...validOverview,
    positions: [{ ...validOverview.positions[0], profitJourney: { givebackRatio: 'unknown' } }],
  }), false)
})
