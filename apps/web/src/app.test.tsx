import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { App } from './app.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    FormData: dom.window.FormData, HTMLCanvasElement: dom.window.HTMLCanvasElement,
  })
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => null, configurable: true })
  Object.defineProperty(dom.window, 'scrollTo', { value: () => undefined, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
}

test.afterEach(() => cleanup())

function portfolioResponse(positions: Array<{ symbol: string; quantity: number; averageCost: number }>, cash = 0) {
  const detailed = positions.map((position) => {
    const marketPrice = position.averageCost
    const costAmount = position.quantity * position.averageCost
    return { ...position, costAmount, marketPrice, marketValue: costAmount, unrealizedProfitLoss: 0, unrealizedReturn: 0, portfolioWeight: null }
  })
  const totalMarketValue = detailed.reduce((sum, position) => sum + position.marketValue, 0)
  const totalEquity = totalMarketValue + cash
  return {
    cash, totalCost: totalMarketValue, totalMarketValue, totalEquity,
    totalUnrealizedProfitLoss: 0, totalUnrealizedReturn: 0,
    pricedPositionCount: detailed.length, unpricedPositionCount: 0,
    positions: detailed.map((position) => ({ ...position, portfolioWeight: totalEquity ? position.marketValue / totalEquity : 0 })),
  }
}

test('用户保存持仓后能在持仓列表看到它', async () => {
  setupDom()
  let positions: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: false } })
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse(positions as Array<{ symbol: string; quantity: number; averageCost: number }>))
    if (url === '/api/positions/NVDA' && init?.method === 'PUT') {
      positions = [{ symbol: 'NVDA', quantity: 12, averageCost: 105 }]
      return Response.json(positions[0])
    }
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '我的持仓' }))
  await user.type(await view.findByLabelText('股票代码'), 'NVDA')
  await user.type(view.getByLabelText('数量'), '12')
  await user.type(view.getByLabelText('平均成本'), '105')
  await user.click(view.getByRole('button', { name: '保存持仓' }))
  await view.findAllByText('NVDA')
  await view.findAllByText('US$1,260.00')
})

test('持仓页展示现金、盈亏和仓位，并能减仓后把卖出所得计入现金', async () => {
  setupDom()
  let portfolio = {
    cash: 500, totalCost: 1000, totalMarketValue: 1250, totalEquity: 1750,
    totalUnrealizedProfitLoss: 250, totalUnrealizedReturn: .25,
    pricedPositionCount: 1, unpricedPositionCount: 0,
    positions: [{
      symbol: 'NVDA', quantity: 10, averageCost: 100, costAmount: 1000,
      marketPrice: 125, marketValue: 1250, unrealizedProfitLoss: 250,
      unrealizedReturn: .25, portfolioWeight: 1250 / 1750,
    }],
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: false } })
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolio)
    if (url === '/api/positions/NVDA/reduce' && init?.method === 'POST') {
      portfolio = {
        ...portfolio, cash: 1000, totalCost: 600, totalMarketValue: 750, totalEquity: 1750,
        totalUnrealizedProfitLoss: 150,
        positions: [{ ...portfolio.positions[0], quantity: 6, costAmount: 600, marketValue: 750, unrealizedProfitLoss: 150, portfolioWeight: 750 / 1750 }],
      }
      return Response.json({ cash: 1000, proceeds: 500, realizedProfitLoss: 100 })
    }
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '我的持仓' }))
  await view.findByText('US$1,750.00')
  await view.findAllByText('+US$250.00')
  assert.ok(view.getByRole('img', { name: /NVDA US\$1,250\.00，现金 US\$500\.00/ }))
  await user.click(view.getByRole('button', { name: '减仓' }))
  await user.type(view.getByLabelText('卖出数量'), '4')
  await view.findByText('US$1,000.00')
  await view.findByText('+US$100.00')
  await user.click(view.getByRole('button', { name: '确认减仓' }))
  await waitFor(() => assert.equal(view.getByLabelText('当前现金').getAttribute('value'), '1000'))
  await view.findAllByText('US$750.00')
})

test('持仓页把组合权益历史画成曲线并按最新日期展示明细', async () => {
  setupDom()
  const snapshots = [
    { marketDay: '2026-08-12', totalEquity: 4451.11, totalMarketValue: 3446.71, cash: 1004.4, holdingsCount: 7, pricedCount: 7, observedAt: '2026-08-12T15:00:00Z', afterClose: false, dailyChange: 0, dailyReturn: 0 },
    { marketDay: '2026-08-11', totalEquity: 4451.11, totalMarketValue: 3446.71, cash: 1004.4, holdingsCount: 7, pricedCount: 7, observedAt: '2026-08-11T20:05:00Z', afterClose: true, dailyChange: 99.96, dailyReturn: .023 },
  ]
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: false } })
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '我的持仓' }))
  assert.ok(await view.findByRole('img', { name: '组合权益历史，共 2 个观测点' }))
  const table = await view.findByRole('table', { name: '组合权益历史明细' })
  assert.match(table.textContent ?? '', /2026-08-12.*US\$4,451\.11.*盘中/)
  assert.match(table.textContent ?? '', /2026-08-11.*\+US\$99\.96.*\+2\.30%.*收盘/)
})

test('用户创建分析并打开研究记录后能看到报告依据', async () => {
  setupDom()
  let statusCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/analyses' && init?.method === 'POST') {
      return Response.json({ analysisId: 'analysis-1', sessionId: 'session-1' }, { status: 202 })
    }
    if (url === '/api/analyses/analysis-1') {
      statusCalls += 1
      return Response.json(statusCalls > 1 ? { id: 'analysis-1', symbol: 'NVDA', status: 'completed', report: { title: 'NVDA 综合分析' } } : { id: 'analysis-1', symbol: 'NVDA', status: 'running' })
    }
    if (url === '/api/research/analysis-1') return Response.json({
      id: 'analysis-1', symbol: 'NVDA', status: 'completed', report: {
        title: 'NVDA 综合分析', trend: '偏强震荡', limitations: [],
        marketState: '价格位于短期均线上方', drivers: ['量价保持强势'],
        supportingEvidence: ['fact-1'], contraryEvidence: ['fact-1'],
        keyJudgments: [{ judgment: '未来一至四周偏强', evidence: ['fact-1'] }],
        scenarios: [{ name: '延续', condition: '站稳均线', outcome: '趋势延续' }],
        invalidationConditions: ['跌破均线'], valuation: 'PE 区间支持当前价格',
      },
      facts: [
        { id: 'fact-1', type: 'quote', value: 217.5, observedAt: '2026-08-12T13:48:38Z', source: 'sina', sourceReference: 'https://example.com' },
        { id: 'valuation-1', type: 'valuation', value: { methods: { pe: { multiple: 70.28 } }, historical_ranges: { pe: [30.74, 56.58] } }, observedAt: '2026-08-12T13:48:38Z', source: 'yahoo-timeseries', sourceReference: 'https://example.com' },
      ],
      trace: [{ type: 'status', status: 'completed' }],
    })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  const symbol = await view.findByLabelText('分析标的')
  await user.clear(symbol)
  await user.type(symbol, 'NVDA')
  await user.click(view.getByRole('button', { name: '开始分析' }))
  await view.findByText('NVDA 综合分析')
  await view.findAllByText('US$217.50')
  await view.findAllByText(/sina/)
  await view.findByText('未来一至四周偏强')
  await view.findByText('PE 区间支持当前价格')
  await waitFor(() => assert.ok(view.getByText('偏强震荡')))
})

test('新建分析页展示分析历史并能重新打开报告', async () => {
  setupDom()
  const summary = {
    id: 'history-1', symbol: 'AAPL', status: 'completed', createdAt: '2026-08-11T08:30:00Z',
    report: { title: 'AAPL 综合分析', trend: '中性偏强' },
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [summary] })
    if (url === '/api/research/history-1') return Response.json({ ...summary, facts: [], trace: [] })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  const history = await view.findByRole('region', { name: '分析历史' })
  assert.match(history.textContent ?? '', /AAPL 综合分析/)
  assert.match(history.textContent ?? '', /2026年8月11日/)
  await user.click(view.getByRole('button', { name: /打开 AAPL 综合分析/ }))
  await view.findByRole('heading', { name: '研究记录' })
  await view.findByRole('heading', { name: 'AAPL 综合分析' })
})

test('坏报告依据被拒绝时用户看到可理解的失败原因', async () => {
  setupDom()
  let statusCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/analyses' && init?.method === 'POST') {
      return Response.json({ analysisId: 'failed-1', sessionId: 'failed-session-1' }, { status: 202 })
    }
    if (url === '/api/analyses/failed-1') {
      statusCalls += 1
      return Response.json(statusCalls > 1
        ? { status: 'failed', error: 'unknown_evidence:fact:not-found' }
        : { status: 'running' })
    }
    if (url === '/api/research/failed-1') return Response.json({
      id: 'failed-1', symbol: 'NVDA', status: 'failed', error: 'unknown_evidence:fact:not-found',
      facts: [], trace: [],
    })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: '开始分析' }))
  await view.findAllByText('AI 引用了一条不存在的报告依据，本次报告已被拒绝。')
})

test('研究报告把结构化事实翻译成人话且不渲染原始事件流', async () => {
  setupDom()
  const record = {
    id: 'research-1', symbol: 'NVDA', status: 'completed',
    report: {
      title: 'NVDA 研究简报', trend: '中性偏强', marketState: '价格保持在中期均线上方。',
      drivers: [], supportingEvidence: ['indicator-1'], contraryEvidence: [],
      keyJudgments: [{ judgment: '动能仍在', evidence: ['indicator-1'] }], scenarios: [], invalidationConditions: [], limitations: [],
    },
    facts: [{ id: 'indicator-1', type: 'indicators', value: { ma_5: 219.44, ma_20: 207.8, rsi_14: 54.26 }, observedAt: '2026-08-12T13:48:38Z', source: 'deterministic-calculation', sourceReference: '' }],
    trace: [...Array.from({ length: 120 }, () => ({ type: 'text_delta', delta: '{"raw":"token"}' })), { type: 'status', status: 'completed' }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status, report: record.report }] })
    if (url === '/api/research/research-1') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '研究记录' }))
  await view.findAllByText('MA5 US$219.44 · MA20 US$207.80 · RSI 54.26')
  assert.equal(view.container.textContent?.includes('{"raw":"token"}'), false)
  await view.findByText(/底层共保存 121 条原始事件/)
})

test('分析轨迹可展开查看各能力的数据源状态与错误', async () => {
  setupDom()
  const record = {
    id: 'research-sources', symbol: 'AAPL', status: 'partial', report: {
      title: 'AAPL 研究简报', trend: '中性', marketState: '行情可用', drivers: [],
      supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
      invalidationConditions: [], limitations: ['财报缺失'],
    }, facts: [], trace: [{
      type: 'financial_context', gaps: [{ capability: 'fundamentals', reason: 'all_sources_unavailable' }],
      capabilities: [
        { capability: 'news', adoptedSource: 'multiple', acceptedCount: 20, sources: [
          { source: 'yahoo', status: 'ok', item_count: 10 },
          { source: 'google-news', status: 'ok', item_count: 100 },
        ] },
        { capability: 'fundamentals', adoptedSource: null, acceptedCount: 0, sources: [
          { source: 'sec', status: 'failed', error: 'UnicodeDecodeError', item_count: 0 },
        ] },
      ],
    }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { database: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status, report: record.report }] })
    if (url === '/api/research/research-sources') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '研究记录' }))
  await user.click(await view.findByText('冻结金融上下文'))
  await user.click(await view.findByText('财报基本面'))
  await view.findByText('UnicodeDecodeError')
  await view.findByText('采用 multiple · 20 条')
})
