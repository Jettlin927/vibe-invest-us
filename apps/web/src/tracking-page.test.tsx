import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TrackingPage } from './tracking-page.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    FormData: dom.window.FormData,
  })
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
}

test.afterEach(() => cleanup())

test('追踪页维护自选、解释变化并从事件进入深入分析', async () => {
  setupDom()
  const calls: string[] = []
  const view = render(<TrackingPage
    overview={{
      watchlist: [{ symbol: 'NVDA', note: '等待财报', enabled: true, createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z' }],
      targets: [{ symbol: 'NVDA', sources: ['watchlist', 'position'] }],
      activeScan: null,
      latestScan: {
        id: 'run-2', status: 'partial', targets: [{ symbol: 'NVDA', sources: ['watchlist', 'position'] }],
        startedAt: '2026-08-30T19:59:00Z', completedAt: '2026-08-30T20:00:01Z', error: null,
        observations: [{
          id: 'gap-observation', runId: 'run-2', symbol: 'NVDA', capability: 'fundamental',
          status: 'data_gap', baselineObservationId: null, observedAt: '2026-08-30T20:00:00Z',
          payload: { gaps: [{ source: 'fundamental', reason: 'all_sources_failed' }] },
        }], events: [],
      },
      events: [{
        id: 'event-1', runId: 'run-2', observationId: 'observation-2', baselineObservationId: 'observation-1',
        eventKey: 'NVDA:technical:ma_cross:2026-08-30', symbol: 'NVDA', capability: 'technical',
        kind: 'technical.ma_cross', severity: 'warning', occurredAt: '2026-08-30T20:00:00Z', createdAt: '2026-08-30T20:00:01Z',
        payload: { direction: 'bullish', previousMa5: 98, previousMa20: 100, currentMa5: 102, currentMa20: 100 },
      }],
    }}
    loading={false} scanning={false}
    onWatch={async (symbol, note) => { calls.push(`watch:${symbol}:${note}`); return true }}
    onUnwatch={async (symbol) => { calls.push(`unwatch:${symbol}`) }}
    onScan={async () => { calls.push('scan') }}
    onAnalyze={async (event, researchId) => { calls.push(`analyze:${event.id}:${researchId}`) }}
    researchRecords={[{ id: 'research-old', symbol: 'NVDA', report: { title: '原有研究' }, createdAt: '2026-08-29T00:00:00Z' }]}
    onOpenResearch={async (id) => { calls.push(`open:${id}`) }}
  />)
  const user = userEvent.setup({ document: window.document })

  assert.match(view.getByRole('region', { name: '股票追踪' }).textContent ?? '', /NVDA.*自选.*持仓/s)
  assert.match(view.getByRole('region', { name: '追踪动态' }).textContent ?? '', /均线结构转强/)
  assert.doesNotMatch(view.getByRole('region', { name: '追踪概览' }).textContent ?? '', /能力完整/)
  assert.match(view.getByRole('region', { name: '数据缺口详情' }).textContent ?? '', /NVDA.*基本面.*all_sources_failed/s)

  await user.type(view.getByLabelText('新增自选股票代码'), 'aapl')
  await user.type(view.getByLabelText('自选备注'), '观察新品周期')
  await user.click(view.getByRole('button', { name: '加入自选' }))
  await user.click(view.getByRole('button', { name: '立即扫描' }))
  assert.equal(view.queryByRole('button', { name: '围绕此变化研究 NVDA' }), null)
  await user.click(view.getByText('查看变化详情'))
  assert.deepEqual(calls, ['watch:AAPL:观察新品周期', 'scan'])
  await user.click(view.getByRole('button', { name: '查看已有研究 NVDA' }))
  await user.click(view.getByRole('button', { name: '围绕此变化研究 NVDA' }))
  await user.click(view.getByRole('button', { name: '移除自选 NVDA' }))

  await waitFor(() => assert.deepEqual(calls, [
    'watch:AAPL:观察新品周期', 'scan', 'open:research-old', 'analyze:event-1:research-old', 'unwatch:NVDA',
  ]))
})

test('Tracking API 不可用时页面显示未知且禁用扫描', () => {
  setupDom()
  const view = render(<TrackingPage
    overview={null} available={false} loading={false} scanning={false}
    onWatch={async () => true}
    onUnwatch={async () => {}}
    onScan={async () => {}}
    onAnalyze={async () => {}}
  />)
  assert.match(view.getByRole('region', { name: '追踪概览' }).textContent ?? '', /完整性未知/)
  assert.equal((view.getByRole('button', { name: '立即扫描' }) as HTMLButtonElement).disabled, true)
})

test('行情扫描成功但盈利保护更新失败时页面显示降级原因', () => {
  setupDom()
  const view = render(<TrackingPage
    overview={{
      watchlist: [], targets: [{ symbol: 'NVDA', sources: ['position'] }], activeScan: null,
      latestScan: {
        id: 'run-protection-partial', status: 'partial',
        targets: [{ symbol: 'NVDA', sources: ['position'] }],
        startedAt: '2026-09-04T20:00:00Z', completedAt: '2026-09-04T20:00:01Z',
        error: 'profit_protection_evaluation_failed',
        observations: [{
          id: 'observation-1', runId: 'run-protection-partial', symbol: 'NVDA',
          capability: 'technical', status: 'success', baselineObservationId: null,
          observedAt: '2026-09-04T20:00:00Z', payload: { gaps: [] },
        }, {
          id: 'observation-2', runId: 'run-protection-partial', symbol: 'NVDA',
          capability: 'fundamental', status: 'data_gap', baselineObservationId: null,
          observedAt: '2026-09-04T20:00:00Z',
          payload: { gaps: [{ source: 'fundamental', reason: 'all_sources_failed' }] },
        }],
        events: [],
      },
      events: [],
    }}
    loading={false} scanning={false}
    onWatch={async () => true}
    onUnwatch={async () => {}}
    onScan={async () => {}}
    onAnalyze={async () => {}}
  />)

  const summary = view.getByRole('region', { name: '追踪概览' })
  assert.match(summary.textContent ?? '', /盈利保护更新失败/)
  assert.doesNotMatch(summary.textContent ?? '', /最近扫描能力完整/)
  const detail = view.getByRole('region', { name: '数据缺口详情' })
  assert.match(detail.textContent ?? '', /行情扫描结果已保留/)
  assert.match(detail.textContent ?? '', /NVDA.*基本面.*all_sources_failed/s)
})

test('添加自选失败时保留用户输入', async () => {
  setupDom()
  const view = render(<TrackingPage
    overview={{ watchlist: [], targets: [], activeScan: null, latestScan: null, events: [] }}
    available loading={false} scanning={false}
    onWatch={async () => false}
    onUnwatch={async () => {}}
    onScan={async () => {}}
    onAnalyze={async () => {}}
  />)
  const user = userEvent.setup({ document: window.document })
  const symbol = view.getByLabelText('新增自选股票代码') as HTMLInputElement
  const note = view.getByLabelText('自选备注') as HTMLInputElement
  await user.type(symbol, 'NVDA')
  await user.type(note, '保留这段备注')
  await user.click(view.getByRole('button', { name: '加入自选' }))
  await waitFor(() => assert.equal((view.getByRole('button', { name: '加入自选' }) as HTMLButtonElement).disabled, false))
  assert.equal(symbol.value, 'NVDA')
  assert.equal(note.value, '保留这段备注')
})
