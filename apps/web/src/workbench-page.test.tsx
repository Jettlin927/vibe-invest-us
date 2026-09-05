import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkbenchPage } from './workbench-page.js'

test.afterEach(cleanup)
test('工作台保存组件配置、按标的展示当前数据并恢复历史版本', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/workbench' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, FormData: dom.window.FormData })
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  const writes: Array<Record<string, unknown>> = []
  const page = { id: 'p1', title: '我的决策页', blocks: [{ type: 'positions', symbols: ['NVDA'] }], revision: 2, updatedAt: '2026-09-05' }
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    if (options?.method === 'POST') { writes.push(JSON.parse(String(options.body))); return Response.json({ page }) }
    if (url.endsWith('/pages/p1')) return Response.json({ page, versions: [{ ...page, revision: 1 }] })
    if (url.endsWith('/pages')) return Response.json({ pages: [page] })
    if (url === '/api/portfolio/stored') return Response.json({ positions: [{ symbol: 'NVDA', quantity: 2, averageCost: 100 }, { symbol: 'AAPL', quantity: 3, averageCost: 200 }] })
    if (url.endsWith('/stances')) return Response.json({ stances: [] })
    if (url.startsWith('/api/tracking')) return Response.json({ watchlist: [] })
    return Response.json({ records: [] })
  }
  const view = render(<WorkbenchPage pageId="p1" onOpen={() => {}} />)
  const user = userEvent.setup({ document: dom.window.document })
  await view.findByText('NVDA')
  assert.equal(view.queryByText('AAPL'), null)
  await user.click(view.getByRole('button', { name: '编辑页面' }))
  await user.clear(view.getByLabelText('页面标题'))
  await user.type(view.getByLabelText('页面标题'), '更新后的页面')
  await user.click(view.getByRole('button', { name: '保存页面' }))
  await waitFor(() => assert.equal(writes.length, 1))
  assert.equal(writes[0].title, '更新后的页面')
  assert.deepEqual(writes[0].blocks, [{ type: 'positions', symbols: ['NVDA'] }])
  await user.click(view.getByText('历史版本'))
  await user.click(view.getByRole('button', { name: '恢复版本 1' }))
  await waitFor(() => assert.equal(writes.length, 2))
  assert.equal(writes[1].revision, 1)
})

test('工作台展示立场来源、验证条件、自选和研究，并明确组件读取失败', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/workbench/p2' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/pages/p2')) return Response.json({ page: { id: 'p2', title: '完整工作台', revision: 1, updatedAt: '2026-09-05', blocks: ['positions', 'stances', 'watchlist', 'research'].map((type) => ({ type })) }, versions: [] })
    if (url.endsWith('/stances')) return Response.json({ stances: [{ id: 's1', symbol: 'NVDA', stance: '等待收入验证', status: 'confirmed', conditions: ['下季收入增长'], sourceThreadId: 't1', sourceRecordId: 'r1', sourceRecordKind: 'conversation' }] })
    if (url.startsWith('/api/tracking')) return Response.json({ watchlist: [{ symbol: 'AAPL', note: '观察新品' }] })
    if (url === '/api/research') return Response.json({ records: [{ id: 'r1', symbol: 'NVDA', report: { title: '订单研究' } }] })
    return Response.json({}, { status: 503 })
  }
  const view = render(<WorkbenchPage pageId="p2" onOpen={() => {}} />)
  await view.findByText('等待收入验证')
  assert.ok(view.getByText('验证条件：下季收入增长'))
  assert.ok(view.getByText(/用户确认/))
  assert.equal(view.getByRole('link', { name: '来源对话' }).getAttribute('href'), '/conversations/t1')
  assert.equal(view.getByRole('link', { name: '来源记录' }).getAttribute('href'), '/conversations/r1')
  assert.ok(view.getByText('观察新品'))
  assert.equal(view.getByRole('link', { name: '订单研究' }).getAttribute('href'), '/research/r1')
  assert.ok(view.getByText('持仓读取失败，请刷新重试。'))
})
