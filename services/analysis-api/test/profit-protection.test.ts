import assert from 'node:assert/strict'
import test from 'node:test'

import { createProfitProtection } from '../src/profit-protection.js'

function createRepository() {
  const plans = new Map<string, Array<Record<string, unknown>>>()
  const states = new Map<string, Record<string, unknown>>()
  const triggers = new Map<string, Record<string, unknown>>()
  return {
    async listLatest() {
      return [...plans.values()].flatMap((versions) => versions.at(-1) ?? [])
    },
    async save(input: Record<string, unknown>) {
      const symbol = String(input.symbol)
      const versions = plans.get(symbol) ?? []
      const plan = {
        id: `plan-${symbol}-${versions.length + 1}`,
        ...input,
        revision: versions.length + 1,
      }
      versions.push(plan)
      plans.set(symbol, versions)
      return plan
    },
    async listStates() { return [...states.values()] },
    async recordEvaluation(input: Record<string, any>) {
      states.set(input.symbol, { symbol: input.symbol, ...input.state })
      if (input.trigger && !triggers.has(input.trigger.eventKey)) {
        triggers.set(input.trigger.eventKey, {
          id: `trigger-${triggers.size + 1}`, ...input.trigger,
          status: 'open', acknowledgedAt: null,
        })
      }
    },
    async listTriggers() { return [...triggers.values()] },
    async acknowledgeTrigger(id: string, acknowledgedAt: string) {
      const entry = [...triggers.values()].find((trigger) => trigger.id === id)
      if (!entry) return null
      Object.assign(entry, { status: 'acknowledged', acknowledgedAt })
      return entry
    },
  }
}

test('盈利保护计划用固定风险锚点计算 R 并在 2R 触发第一次兑现', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }

  const plan = await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  assert.equal(plan.revision, 1)
  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 216, portfolioWeight: 0.08 }],
  })
  assert.deepEqual(status, {
    symbol: 'CRDO', status: 'triggered', planRevision: 1,
    currentR: 2, bindingRule: 'first_take_profit',
    nextRule: { kind: 'second_take_profit', atR: 3 },
    coreRatio: 0.6, tradingRatio: 0.4,
    anchorPrice: 180, invalidationPrice: 162, maxPortfolioWeight: 0.1,
    marketPrice: 216, portfolioWeight: 0.08,
    levels: { firstTakeProfit: 216, secondTakeProfit: 234, trailingStart: 252 },
  })
})

test('达到 3R 时第二次兑现覆盖已经通过的 2R 规则', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 234, portfolioWeight: 0.08 }],
  })

  assert.equal(status?.bindingRule, 'second_take_profit')
  assert.deepEqual(status?.nextRule, { kind: 'activate_trailing', atR: 4 })
})

test('达到 4R 时提示为核心仓启用移动保护', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 252, portfolioWeight: 0.08 }],
  })

  assert.equal(status?.bindingRule, 'activate_trailing')
  assert.equal(status?.nextRule, null)
})

test('跌破失效价时 thesis 复核优先于其他仓位规则', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 160, portfolioWeight: 0.12 }],
  })

  assert.equal(status?.status, 'triggered')
  assert.equal(status?.bindingRule, 'thesis_invalidation')
})

test('仓位超过计划上限时在尚未到达兑现阶梯前触发集中度规则', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 198, portfolioWeight: 0.12 }],
  })

  assert.equal(status?.bindingRule, 'max_weight')
})

test('行情缺失时关闭 R 判断而不是把缺口当作正常', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, position, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: null, portfolioWeight: null }],
  })

  assert.equal(status?.status, 'data_gap')
  assert.equal(status?.currentR, null)
  assert.equal(status?.bindingRule, null)
})

test('持仓数量或平均成本变化后要求复核而不静默重算风险锚点', async () => {
  const protection = createProfitProtection(createRepository())
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
  }, { symbol: 'CRDO', quantity: 5, averageCost: 180 }, '2026-09-04T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{
      symbol: 'CRDO', quantity: 6, averageCost: 183,
      marketPrice: 216, portfolioWeight: 0.08,
    }],
    signals: { CRDO: { ema20: 205, peakPrice: 260, observedAt: '2026-09-04' } },
  })

  assert.equal(status?.status, 'review_required')
  assert.equal(status?.bindingRule, 'position_changed')
  assert.equal(status?.currentR, 2)
  assert.equal(status?.profitJourney, undefined)
})

test('保护计划拒绝无风险距离或不匹配当前持仓的输入', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }

  await assert.rejects(
    protection.savePlan({
      symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 180,
      coreRatio: 0.6, maxPortfolioWeight: 0.1,
    }, position, '2026-09-04T00:00:00.000Z'),
    /invalid_profit_protection_plan/,
  )
  await assert.rejects(
    protection.savePlan({
      symbol: 'MRVL', anchorPrice: 180, invalidationPrice: 162,
      coreRatio: 0.6, maxPortfolioWeight: 0.1,
    }, position, '2026-09-04T00:00:00.000Z'),
    /profit_protection_position_mismatch/,
  )
})

test('进入显式财报风险窗口后事件规则优先于仓位和兑现阶梯', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 0.1,
    earningsDate: '2026-09-10', earningsRiskStartsAt: '2026-09-03',
  }, position, '2026-09-01T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    asOf: '2026-09-04',
    positions: [{ ...position, marketPrice: 234, portfolioWeight: 0.12 }],
  })

  assert.equal(status?.bindingRule, 'earnings_window')
  assert.deepEqual(status?.earnings, {
    date: '2026-09-10', riskStartsAt: '2026-09-03', inRiskWindow: true,
  })
})

test('财报风险窗口按美东市场日而不是 UTC 日期判断', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 1,
    earningsDate: '2026-09-10', earningsRiskStartsAt: '2026-09-03',
  }, position, '2026-09-01T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    asOf: '2026-09-03T01:00:00.000Z',
    positions: [{ ...position, marketPrice: 198, portfolioWeight: 1 }],
  })

  assert.notEqual(status?.bindingRule, 'earnings_window')
  assert.equal(status?.earnings?.inRiskWindow, false)
})

test('历史峰值达到 4R 后跌破 EMA20 会触发移动保护并计算利润回吐', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 1,
  }, position, '2026-09-01T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 230, portfolioWeight: 1 }],
    signals: { CRDO: { ema20: 235, peakPrice: 260, observedAt: '2026-09-04' } },
  })

  assert.equal(status?.bindingRule, 'trailing_stop')
  assert.deepEqual(status?.trailing, {
    active: true, ema20: 235, observedAt: '2026-09-04', peakPrice: 260,
  })
  assert.deepEqual(status?.profitJourney, {
    peakUnrealizedProfit: 400,
    currentUnrealizedProfit: 250,
    givebackAmount: 150,
    givebackRatio: 0.375,
  })
})

test('利润回吐按计划冻结的持仓成本而不是风险锚点计算', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 10, averageCost: 100 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 120, invalidationPrice: 110,
    coreRatio: 0.6, maxPortfolioWeight: 1,
  }, position, '2026-09-01T00:00:00.000Z')

  const [status] = await protection.evaluatePortfolio({
    positions: [{ ...position, marketPrice: 130, portfolioWeight: 1 }],
    signals: { CRDO: { ema20: 125, peakPrice: 150, observedAt: '2026-09-04' } },
  })

  assert.deepEqual(status?.profitJourney, {
    peakUnrealizedProfit: 500,
    currentUnrealizedProfit: 300,
    givebackAmount: 200,
    givebackRatio: 0.4,
  })
})

test('追踪观测会持久化一次性触发事件并允许用户确认处理', async () => {
  const protection = createProfitProtection(createRepository())
  const position = { symbol: 'CRDO', quantity: 5, averageCost: 180 }
  await protection.savePlan({
    symbol: 'CRDO', anchorPrice: 180, invalidationPrice: 162,
    coreRatio: 0.6, maxPortfolioWeight: 1,
  }, position, '2026-09-01T00:00:00.000Z')
  const observation = {
    asOf: '2026-09-04',
    positions: [{ ...position, marketPrice: 230, portfolioWeight: 1 }],
    signals: { CRDO: { ema20: 235, peakPrice: 260, observedAt: '2026-09-04' } },
  }

  await protection.observePortfolio(observation)
  await protection.observePortfolio({
    ...observation,
    signals: { CRDO: { ema20: 235, peakPrice: 230, observedAt: '2026-09-05' } },
  })
  const [trigger] = await protection.listTriggers()
  const [persisted] = await protection.evaluatePortfolio({
    positions: observation.positions,
  })

  assert.equal((await protection.listTriggers()).length, 1)
  assert.equal(persisted?.trailing?.peakPrice, 260)
  assert.equal(trigger?.rule, 'trailing_stop')
  assert.equal(trigger?.status, 'open')
  const acknowledged = await protection.acknowledgeTrigger(
    String(trigger?.id), '2026-09-04T12:00:00.000Z',
  )
  assert.equal(acknowledged?.status, 'acknowledged')
})
