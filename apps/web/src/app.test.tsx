import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultRuntimeSettings } from '@vibe-invest/contracts'

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

function settingsResponse(overrides: Partial<Record<keyof typeof defaultRuntimeSettings, number>> = {}) {
  return {
    model: { configured: true },
    current: {
      id: 1, createdAt: new Date().toISOString(),
      values: { ...defaultRuntimeSettings, ...overrides },
    },
    defaults: defaultRuntimeSettings,
    activeExecutions: [],
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
      trace: [
        { type: 'tool_call', name: 'search_news_by_keyword', toolCallId: 'news-call', startedAt: '2026-08-12T13:48:38.000Z' },
        { type: 'tool_result', name: 'search_news_by_keyword', toolCallId: 'news-call', startedAt: '2026-08-12T13:48:38.000Z', completedAt: '2026-08-12T13:48:38.125Z', completionOrder: 1 },
        { type: 'tool_call', name: 'get_technical_indicators', toolCallId: 'cancelled-call', input: {}, startedAt: null, notStarted: true },
        { type: 'tool_result', name: 'get_technical_indicators', toolCallId: 'cancelled-call', startedAt: null, notStarted: true, completedAt: '2026-08-12T13:48:38.125Z', completionOrder: 2, isError: true },
        { type: 'status', status: 'completed' },
      ],
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
  await user.click(view.getByText('调用只读工具'))
  assert.ok(view.getAllByText(/开始/).some((item) => /2026/.test(item.textContent ?? '')))
  await view.findByText('未开始')
  await user.click(view.getByText('工具返回事实'))
  await view.findByText('耗时 125 毫秒 · 完成序 #1')
  await view.findByText('未开始即取消')
  assert.equal(document.querySelector('[data-tool-call-id="news-call"]') !== null, true)
  assert.equal(document.querySelector('[data-tool-call-id="cancelled-call"]') !== null, true)
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
  await view.findByRole('heading', { name: '研究记录' }, { timeout: 2_000 })
  await view.findByRole('heading', { name: 'AAPL 综合分析' })
})

test('研究页展示主 Agent、execution、conversation segment、waitReason 与历史事件', async () => {
  setupDom()
  const record = {
    id: 'runtime-1', symbol: 'NVDA', status: 'planning', createdAt: '2026-08-13T03:00:00.000Z',
    report: null, facts: [], trace: [],
    mainAgent: {
      id: 'session-1', status: 'planning',
      waitReason: { kind: 'database', target: '首次研究初始化', startedAt: '2026-08-13T03:00:00.000Z' },
      execution: { id: 'execution-1', generation: 1, status: 'planning' },
      segments: [{ id: 'segment-1', ordinal: 1, createdAt: '2026-08-13T03:00:00.000Z' }],
      events: [{ sequence: 1, type: 'runtime_context', status: 'planning', createdAt: '2026-08-13T03:00:00.000Z', waitReason: { kind: 'database', target: '首次研究初始化', startedAt: '2026-08-13T03:00:00.000Z' } }],
    },
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status, createdAt: record.createdAt }] })
    if (url === '/api/research/runtime-1') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))
  const runtime = await view.findByRole('region', { name: '主 Agent Runtime' })
  assert.match(runtime.textContent ?? '', /session-1/)
  assert.match(runtime.textContent ?? '', /execution-1.*Generation 1/)
  assert.match(runtime.textContent ?? '', /Segment 1/)
  assert.match(runtime.textContent ?? '', /首次研究初始化/)
  assert.match(runtime.textContent ?? '', /Runtime Context/)
  assert.match(runtime.textContent ?? '', /等待 首次研究初始化/)
})

test('研究页展示 Compaction token usage 耗时与链接的新 Segment', async () => {
  setupDom()
  const record = {
    id: 'compact-ui', symbol: 'NVDA', status: 'completed',
    createdAt: '2026-08-14T01:00:00.000Z', report: null, facts: [], trace: [],
    mainAgent: {
      id: 'compact-session', status: 'completed', waitReason: null,
      execution: { id: 'compact-execution', generation: 1, status: 'completed' },
      segments: [
        { id: 'segment-1', ordinal: 1, parentSegmentId: null, createdAt: '2026-08-14T01:00:00Z' },
        { id: 'segment-2', ordinal: 2, parentSegmentId: 'segment-1', createdAt: '2026-08-14T01:01:00Z' },
      ],
      events: [{
        sequence: 1, type: 'context_usage', createdAt: '2026-08-14T01:00:59Z',
        contextTokens: 18000, contextWindow: 128000, reserveTokens: 16384,
        keepRecentTokens: 20000, estimated: true,
      }, {
        sequence: 2, type: 'compaction', status: 'completed', createdAt: '2026-08-14T01:01:00Z',
        contextTokens: 120000, contextWindow: 128000, reserveTokens: 16384,
        keepRecentTokens: 20000, tokensAfter: 18000, estimated: true, durationMs: 1250,
        usage: { input: 1000, output: 100, totalTokens: 1100 },
      }],
      compactionAttempts: [{
        compactionId: 'compact-1', attempt: 1, status: 'failed', durationMs: 500,
        usage: { input: 500, output: 20, totalTokens: 520 },
      }, {
        compactionId: 'compact-1', attempt: 2, status: 'completed', durationMs: 750,
        usage: { input: 1000, output: 100, totalTokens: 1100 },
      }],
    },
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status, createdAt: record.createdAt }] })
    if (url === '/api/research/compact-ui') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))
  const runtime = await view.findByRole('region', { name: '主 Agent Runtime' })
  assert.match(runtime.textContent ?? '', /Segment 2.*源自 Segment 1/)
  assert.match(runtime.textContent ?? '', /Compaction.*120,000.*128,000/)
  assert.match(runtime.textContent ?? '', /保留 16,384.*近期 20,000/)
  assert.match(runtime.textContent ?? '', /1,100 Token.*压缩后 18,000.*1\.25 秒/)
  assert.match(runtime.textContent ?? '', /上下文 ≈14\.1%.*距 Compaction 93,616 Token.*绿色.*Segment 2/)
  assert.match(runtime.textContent ?? '', /Compaction 尝试 1.*失败.*520 Token.*0\.50 秒/)
  assert.match(runtime.textContent ?? '', /Compaction 尝试 2.*完成.*1,100 Token.*0\.75 秒/)
})

test('研究页只允许手动恢复 stopped 或 interrupted 记录', async () => {
  setupDom()
  Reflect.deleteProperty(globalThis, 'EventSource')
  let resumed = false
  let status = 'stopped'
  const record = () => ({
    id: 'resume-1', symbol: 'NVDA', status, report: null, facts: [], trace: [],
    mainAgent: {
      id: 'resume-session', status,
      waitReason: null,
      execution: { id: resumed ? 'resume-new' : 'resume-old', generation: resumed ? 2 : 1, status },
      segments: [{ id: 'resume-segment', ordinal: 1, createdAt: '2026-08-13T03:00:00Z' }],
      events: [],
    },
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: true } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: 'resume-1', symbol: 'NVDA', status }] })
    if (url === '/api/research/resume-1') return Response.json(record())
    if (url === '/api/analyses/resume-1/resume' && init?.method === 'POST') {
      resumed = true
      status = 'completed'
      return Response.json({ sessionId: 'resume-session', executionId: 'resume-new', generation: 2 }, { status: 202 })
    }
    if (url === '/api/analyses/resume-1') return Response.json({ status, terminal: status === 'completed' })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))
  const resume = await view.findByRole('button', { name: '恢复研究' })
  await user.click(resume)
  await waitFor(() => assert.equal(resumed, true))
  await waitFor(() => assert.equal(view.queryByRole('button', { name: '恢复研究' }), null))
})

test('研究页固定展示未启动的消息面专项及理由', async () => {
  setupDom()
  const record = {
    id: 'news-not-started', symbol: 'NVDA', status: 'completed',
    report: null, facts: [], trace: [],
    specialistAgents: [{
      domain: 'news', status: 'not_started',
      researchQuestion: '近期是否有改变预期的公司事件？',
      reason: '当前事实已覆盖研究问题。',
    }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status }] })
    if (url === '/api/research/news-not-started') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))

  const specialist = await view.findByRole('region', { name: '消息面专项 Agent' })
  assert.match(specialist.textContent ?? '', /未启动/)
  assert.match(specialist.textContent ?? '', /近期是否有改变预期的公司事件/)
  assert.match(specialist.textContent ?? '', /当前事实已覆盖研究问题/)
})

test('研究页独立展示消息面专项的工具轨迹、证据缺口和版本报告', async () => {
  setupDom()
  const record = {
    id: 'news-completed', symbol: 'NVDA', status: 'completed', report: null, facts: [], trace: [],
    specialistAgents: [{
      id: 'news-session', domain: 'news', status: 'completed',
      researchQuestion: '近期事件是否改变预期？', reason: '需要核验消息面。',
      execution: { id: 'news-execution', generation: 1, status: 'completed' },
      events: [
        { sequence: 1, type: 'tool_call', name: 'search_news_candidates', createdAt: '2026-08-13T03:00:00Z' },
        { sequence: 2, type: 'tool_call', name: 'read_news_document', createdAt: '2026-08-13T03:00:01Z' },
      ],
      reportVersion: { version: 1, report: {
        gaps: [{ capability: 'contrary_news', reason: '未找到独立反方来源', impact: '置信度受限' }],
        keyJudgments: [{ statement: '产品事件对近期预期偏正面', direction: 'bullish', confidence: 'medium' }],
      } },
    }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status }] })
    if (url === '/api/research/news-completed') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))

  const specialist = await view.findByRole('region', { name: '消息面专项 Agent' })
  assert.match(specialist.textContent ?? '', /search_news_candidates/)
  assert.match(specialist.textContent ?? '', /read_news_document/)
  assert.match(specialist.textContent ?? '', /报告版本 1/)
  assert.match(specialist.textContent ?? '', /未找到独立反方来源.*置信度受限/)
  assert.match(specialist.textContent ?? '', /产品事件对近期预期偏正面.*中等/)
})

test('研究页固定展示基本面专项，并独立展示工具轨迹和不可变版本', async () => {
  setupDom()
  const record = {
    id: 'fundamental-completed', symbol: 'NVDA', status: 'completed', report: null, facts: [], trace: [],
    specialistAgents: [{
      id: 'fundamental-session', domain: 'fundamental_valuation', status: 'completed',
      researchQuestion: '最新财务质量是否改变方向？', reason: '需要核验正式财务事实。',
      execution: { id: 'fundamental-execution', generation: 1, status: 'completed' },
      events: [
        { sequence: 1, type: 'tool_call', name: 'get_financial_overview', createdAt: '2026-08-13T03:00:00Z' },
        { sequence: 2, type: 'tool_call', name: 'read_filing_document', createdAt: '2026-08-13T03:00:01Z' },
      ],
      reportVersion: { version: 1, report: {
        gaps: [{ capability: 'guidance', reason: '未发现正式指引', impact: '置信度受限' }],
        keyJudgments: [{ statement: '正式财务事实支持基本面偏强', direction: 'bullish', confidence: 'medium' }],
        targetPrice: {
          method: 'pe', range: { low: 80, high: 128 }, asOf: '2026-08-12T14:30:00Z',
        },
      } },
    }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status }] })
    if (url === '/api/research/fundamental-completed') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))

  const specialist = await view.findByRole('region', { name: '基本面专项 Agent' })
  assert.match(specialist.textContent ?? '', /get_financial_overview/)
  assert.match(specialist.textContent ?? '', /read_filing_document/)
  assert.match(specialist.textContent ?? '', /报告版本 1/)
  assert.match(specialist.textContent ?? '', /未发现正式指引.*置信度受限/)
  assert.match(specialist.textContent ?? '', /正式财务事实支持基本面偏强.*中等/)
  assert.match(specialist.textContent ?? '', /估值区间.*80.*128.*pe.*2026-08-12T14:30:00Z/)
})

test('研究页独立展示技术面专项的多周期报告与工具轨迹', async () => {
  setupDom()
  const record = {
    id: 'technical-completed', symbol: 'NVDA', status: 'completed', report: null, facts: [], trace: [],
    specialistAgents: [{
      id: 'technical-session', domain: 'technical', status: 'completed',
      researchQuestion: '多周期结构是否一致？', reason: '需要核验完整历史。',
      execution: { id: 'technical-execution', generation: 1, status: 'completed' },
      events: [
        { sequence: 1, type: 'tool_call', name: 'get_technical_evidence', createdAt: '2026-08-13T03:00:00Z' },
        { sequence: 2, type: 'tool_call', name: 'get_price_window', createdAt: '2026-08-13T03:00:01Z' },
      ],
      reportVersion: { version: 1, report: {
        gaps: [{ capability: '252d', reason: '长期历史不足', impact: '长期置信度受限' }],
        keyJudgments: [{ statement: '短周期偏强但中周期冲突', direction: 'neutral', confidence: 'medium' }],
      } },
    }],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status }] })
    if (url === '/api/research/technical-completed') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))

  const specialist = await view.findByRole('region', { name: '技术面专项 Agent' })
  assert.match(specialist.textContent ?? '', /get_technical_evidence/)
  assert.match(specialist.textContent ?? '', /get_price_window/)
  assert.match(specialist.textContent ?? '', /短周期偏强但中周期冲突.*中性.*中等/)
  assert.match(specialist.textContent ?? '', /长期历史不足.*长期置信度受限/)
})

test('研究页同时展示主 Agent 等待目标和完整三专项树', async () => {
  setupDom()
  const sessions = [
    ['news', 'news-session'],
    ['fundamental_valuation', 'fundamental-session'],
    ['technical', 'technical-session'],
  ] as const
  const record = {
    id: 'parallel-tree', symbol: 'NVDA', status: 'waiting_for_specialists',
    report: null, facts: [], trace: [],
    mainAgent: {
      id: 'main-session', status: 'waiting_for_specialists',
      waitReason: {
        kind: 'specialists', target: `专项 Session：${sessions.map(([, id]) => id).join('、')}`,
        startedAt: '2026-08-14T01:00:00Z',
      },
      execution: { id: 'main-execution', generation: 1, status: 'waiting_for_specialists' },
      segments: [{ id: 'main-segment', ordinal: 1, createdAt: '2026-08-14T00:59:00Z' }],
      events: [],
    },
    specialistAgents: sessions.map(([domain, id]) => ({
      id, domain, status: 'running_model', researchQuestion: `${domain} question`,
      reason: `${domain} reason`, execution: { id: `${id}-execution`, generation: 1, status: 'running_model' },
      events: [],
    })),
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [{ id: record.id, symbol: record.symbol, status: record.status }] })
    if (url === '/api/research/parallel-tree') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.click(await view.findByRole('button', { name: /打开 NVDA/ }))

  for (const name of ['消息面专项 Agent', '基本面专项 Agent', '技术面专项 Agent']) {
    assert.ok(await view.findByRole('region', { name }))
  }
  const main = await view.findByRole('region', { name: '主 Agent Runtime' })
  for (const [, id] of sessions) assert.match(main.textContent ?? '', new RegExp(id))
})

test('模型未配置时首次研究创建后立即打开主 Agent 生命周期', async () => {
  setupDom()
  let created = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json({ ...settingsResponse(), model: { configured: false } })
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: created ? [{ id: 'no-model', symbol: 'NVDA', status: 'queued' }] : [] })
    if (url === '/api/analyses' && init?.method === 'POST') { created = true; return Response.json({ analysisId: 'no-model', sessionId: 'session-no-model' }, { status: 202 }) }
    if (url === '/api/research/no-model') return Response.json({
      id: 'no-model', symbol: 'NVDA', status: 'queued', facts: [], trace: [],
      mainAgent: { id: 'session-no-model', status: 'planning', waitReason: { kind: 'database', target: '首次研究初始化', startedAt: '2026-08-13T03:00:00Z' }, execution: { id: 'execution-no-model', generation: 1, status: 'planning' }, segments: [{ id: 'segment', ordinal: 1, createdAt: '2026-08-13T03:00:00Z' }], events: [{ sequence: 1, type: 'runtime_context', status: 'planning', createdAt: '2026-08-13T03:00:00Z' }] },
    })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.type(await view.findByLabelText('分析标的'), 'NVDA')
  await user.click(view.getByRole('button', { name: '开始分析' }))
  assert.match((await view.findByRole('region', { name: '主 Agent Runtime' })).textContent ?? '', /首次研究初始化/)
})

for (const terminal of ['stopped', 'budget_exhausted']) {
  test(`轮询在 ${terminal} 终态打开研究页`, async () => {
    setupDom()
    Reflect.deleteProperty(globalThis, 'EventSource')
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok' }, financialData: { service: 'financial-data', status: 'ok' } } })
      if (url === '/api/settings') return Response.json(settingsResponse())
      if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
      if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
      if (url === '/api/research') return Response.json({ records: [] })
      if (url === '/api/analyses' && init?.method === 'POST') return Response.json({ analysisId: `poll-${terminal}`, sessionId: `session-${terminal}` }, { status: 202 })
      if (url === `/api/analyses/poll-${terminal}`) return Response.json({ id: `poll-${terminal}`, status: terminal })
      if (url === `/api/research/poll-${terminal}`) return Response.json({ id: `poll-${terminal}`, symbol: 'NVDA', status: terminal, facts: [], trace: [] })
      throw new Error(`unexpected_fetch:${url}`)
    }
    const view = render(React.createElement(App))
    const user = userEvent.setup({ document: window.document })
    await user.click(await view.findByRole('button', { name: '新建分析' }))
    await user.type(await view.findByLabelText('分析标的'), 'NVDA')
    await user.click(view.getByRole('button', { name: '开始分析' }))
    await view.findByRole('heading', { name: '研究记录' })
  })
}

test('轮询经过 stopping 后在 stopped 终止并打开研究页', async () => {
  setupDom()
  Reflect.deleteProperty(globalThis, 'EventSource')
  let polls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 10 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json(settingsResponse())
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/analyses' && init?.method === 'POST') return Response.json({ analysisId: 'poll-stop', sessionId: 'session-stop' }, { status: 202 })
    if (url === '/api/analyses/poll-stop') {
      polls += 1
      return Response.json({ id: 'poll-stop', status: polls === 1 ? 'stopping' : 'stopped' })
    }
    if (url === '/api/research/poll-stop') return Response.json({ id: 'poll-stop', symbol: 'NVDA', status: 'stopped', facts: [], trace: [] })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.type(await view.findByLabelText('分析标的'), 'NVDA')
  await user.click(view.getByRole('button', { name: '开始分析' }))
  await view.findByRole('heading', { name: '研究记录' })
  assert.ok(polls >= 2)
})

test('轮询遇到非终态 budget_exhausted 会继续等待 finalizing 与完成', async () => {
  setupDom()
  Reflect.deleteProperty(globalThis, 'EventSource')
  let polls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 10 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json(settingsResponse())
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    if (url === '/api/analyses' && init?.method === 'POST') return Response.json({ analysisId: 'poll-budget-close', sessionId: 'session-budget-close' }, { status: 202 })
    if (url === '/api/analyses/poll-budget-close') {
      polls += 1
      if (polls === 1) return Response.json({ status: 'budget_exhausted', terminal: false })
      if (polls === 2) return Response.json({ status: 'finalizing', terminal: false })
      return Response.json({ status: 'completed', terminal: true })
    }
    if (url === '/api/research/poll-budget-close') return Response.json({ id: 'poll-budget-close', symbol: 'NVDA', status: 'completed', facts: [], trace: [] })
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '新建分析' }))
  await user.type(await view.findByLabelText('分析标的'), 'NVDA')
  await user.click(view.getByRole('button', { name: '开始分析' }))
  await view.findByRole('heading', { name: '研究记录' }, { timeout: 2_000 })
  assert.ok(polls >= 3)
})

test('报告 freshness 按报告年龄提示且不因历史事实改写报告内容', async () => {
  setupDom()
  const oldTitle = '保持原样的历史报告标题'
  const oldLimitations = ['原始限制']
  const oldRecord = {
    id: 'old-report', symbol: 'NVDA', status: 'completed',
    createdAt: new Date().toISOString(),
    reportCreatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    report: { title: oldTitle, trend: '中性', limitations: oldLimitations },
    facts: [{
      id: 'old-financial', type: 'reported_financial', value: {},
      observedAt: '2020-01-01T00:00:00.000Z', source: 'sec', sourceReference: 'https://example.com',
    }],
    trace: [],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json(settingsResponse({ reportFreshnessDays: 7 }))
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [oldRecord] })
    if (url === '/api/research/old-report') return Response.json(oldRecord)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '研究记录' }))
  await view.findByText('此报告已超过当前 7 天有效期，请重新生成后再据此判断。')
  assert.equal(view.getByRole('heading', { name: oldTitle }).textContent, oldTitle)
  assert.deepEqual(oldRecord.report.limitations, oldLimitations)
})

test('刚生成报告即使引用历史财报也不显示 freshness 过期提示', async () => {
  setupDom()
  const freshRecord = {
    id: 'fresh-report', symbol: 'NVDA', status: 'completed',
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    reportCreatedAt: new Date().toISOString(),
    report: { title: '刚生成的报告', trend: '中性', limitations: [] },
    facts: [{ id: 'historical', type: 'reported_financial', value: {}, observedAt: '2019-01-01T00:00:00.000Z', source: 'sec', sourceReference: 'https://example.com' }],
    trace: [],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json(settingsResponse({ reportFreshnessDays: 1 }))
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [freshRecord] })
    if (url === '/api/research/fresh-report') return Response.json(freshRecord)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '研究记录' }))
  await view.findByRole('heading', { name: '刚生成的报告' })
  assert.equal(view.queryByText(/此报告已超过当前/), null)
})

test('备注更新不改变报告 freshness 年龄', async () => {
  setupDom()
  const reportCreatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
  const record = {
    id: 'noted-report', symbol: 'NVDA', status: 'completed',
    createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(), reportCreatedAt,
    report: { title: '备注后的旧报告', trend: '中性', limitations: [] }, facts: [], trace: [],
  }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings') return Response.json(settingsResponse({ reportFreshnessDays: 7 }))
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [record] })
    if (url === '/api/research/noted-report') return Response.json(record)
    throw new Error(`unexpected_fetch:${url}`)
  }
  const view = render(React.createElement(App))
  await userEvent.setup({ document: window.document }).click(await view.findByRole('button', { name: '研究记录' }))
  await view.findByText('此报告已超过当前 7 天有效期，请重新生成后再据此判断。')
  assert.equal(record.reportCreatedAt, reportCreatedAt)
  assert.equal(record.report.title, '备注后的旧报告')
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

test('设置页展示当前、默认、修改时间与运行 execution 冻结值并可保存和恢复', async () => {
  setupDom()
  let currentRounds = 100
  let currentRevision = 2
  const requests: Array<{ url: string; method: string }> = []
  const settingsResponse = () => ({
    model: { configured: true },
    current: {
      id: currentRevision,
      createdAt: '2026-08-13T03:00:00.000Z',
      values: runtimeSettings({ mainAgentToolRounds: currentRounds }),
    },
    defaults: runtimeSettings(),
    activeExecutions: [{
      executionId: 'execution-1', id: 1, createdAt: '2026-08-13T02:55:00.000Z',
      values: runtimeSettings({ mainAgentToolRounds: 20 }),
    }],
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings' && (!init?.method || init.method === 'GET')) return Response.json(settingsResponse())
    if (url === '/api/settings' && init?.method === 'PUT') {
      requests.push({ url, method: init.method })
      currentRounds = JSON.parse(String(init.body)).mainAgentToolRounds
      currentRevision += 1
      return Response.json(settingsResponse().current)
    }
    if (url === '/api/settings/defaults' && init?.method === 'POST') {
      requests.push({ url, method: init.method })
      currentRounds = 20
      currentRevision += 1
      return Response.json(settingsResponse().current)
    }
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    throw new Error(`unexpected_fetch:${url}`)
  }

  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '系统设置' }))
  await view.findByText('当前 revision #2')
  await view.findByText(/上次修改：2026年8月13日 11:00/)
  await view.findByText(/运行 execution execution-1/)
  await view.findByText(/主 Agent 20 轮.*墙钟 45 分钟.*研究\/模型\/工具并发 2\/4\/8.*Freshness 7 天.*Compaction 保留 16,384 Token/)
  const rounds = view.getByRole('spinbutton', { name: '主 Agent 轮次' })
  assert.equal((rounds as HTMLInputElement).value, '100')
  assert.equal((rounds as HTMLInputElement).max, '500')
  assert.match(rounds.parentElement?.textContent ?? '', /默认 20/)

  await user.clear(rounds)
  await user.type(rounds, '120')
  await user.click(view.getByRole('button', { name: '保存 Runtime 设置' }))
  assert.deepEqual(requests[0], { url: '/api/settings', method: 'PUT' })
  await user.click(view.getAllByRole('button', { name: '恢复此项' })[0]!)
  assert.deepEqual(requests[1], { url: '/api/settings', method: 'PUT' })
  await waitFor(() => assert.equal((view.getByRole('spinbutton', { name: '主 Agent 轮次' }) as HTMLInputElement).value, '20'))
  await user.click(view.getByRole('button', { name: '恢复全部默认值' }))
  assert.deepEqual(requests[2], { url: '/api/settings/defaults', method: 'POST' })
})

test('设置写入失败可见且提交期间禁用并防止重复请求', async () => {
  setupDom()
  let putCalls = 0
  let putResponse: (response: Response) => void = () => {}
  let operation: 'save' | 'field' | 'defaults' = 'save'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/health') return Response.json({ service: 'analysis-api', status: 'ok', dependencies: { productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 }, financialData: { service: 'financial-data', status: 'ok' } } })
    if (url === '/api/settings' && (!init?.method || init.method === 'GET')) return Response.json({
      model: { configured: true },
      current: { id: 2, createdAt: '2026-08-13T03:00:00.000Z', values: runtimeSettings() },
      defaults: runtimeSettings(),
      activeExecutions: [],
    })
    if (url === '/api/settings' && init?.method === 'PUT') {
      putCalls += 1
      if (operation === 'save') return new Promise<Response>((resolve) => { putResponse = resolve })
      return Response.json({ error: 'database_unavailable' }, { status: 500 })
    }
    if (url === '/api/settings/defaults' && init?.method === 'POST') {
      return Response.json({ error: 'database_unavailable' }, { status: 500 })
    }
    if (url === '/api/portfolio/history?limit=30') return Response.json({ currency: 'USD', snapshots: [] })
    if (url === '/api/portfolio') return Response.json(portfolioResponse([]))
    if (url === '/api/research') return Response.json({ records: [] })
    throw new Error(`unexpected_fetch:${url}`)
  }

  const view = render(React.createElement(App))
  const user = userEvent.setup({ document: window.document })
  await user.click(await view.findByRole('button', { name: '系统设置' }))
  const save = view.getByRole('button', { name: '保存 Runtime 设置' })
  await user.click(save)
  await user.click(view.getByRole('button', { name: '保存中…' }))
  assert.equal(putCalls, 1)
  assert.equal((view.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled, true)
  assert.equal((view.getByRole('button', { name: '恢复全部默认值' }) as HTMLButtonElement).disabled, true)
  putResponse(Response.json({ error: 'invalid_runtime_setting:mainAgentToolRounds' }, { status: 400 }))
  await view.findByText(/Runtime 设置保存失败.*400.*invalid_runtime_setting/)

  operation = 'field'
  await user.click(view.getAllByRole('button', { name: '恢复此项' })[0]!)
  await view.findByText(/Runtime 设置恢复失败.*500.*database_unavailable/)

  operation = 'defaults'
  await user.click(view.getByRole('button', { name: '恢复全部默认值' }))
  await view.findByText(/Runtime 设置恢复失败.*500.*database_unavailable/)
})

function runtimeSettings(overrides: Record<string, number> = {}) {
  return { ...defaultRuntimeSettings, ...overrides }
}
