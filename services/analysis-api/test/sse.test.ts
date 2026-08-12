import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp as buildProductionApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'

function buildApp(dependencies: Parameters<typeof buildProductionApp>[0]) {
  return buildProductionApp({ ...createTestProductDatabase(), ...dependencies })
}

test('真实 HTTP SSE 断线后用 Last-Event-ID 补回事件再继续 live', async () => {
  let finishModel: (() => void) | undefined
  const modelMayFinish = new Promise<void>((resolve) => { finishModel = resolve })
  const app = buildApp({
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({
      symbol, gaps: [], facts: [{
        id: 'fact-1', type: 'quote', value: 100, observedAt: '2026-08-12T00:00:00Z',
        fetchedAt: '2026-08-12T00:00:01Z', source: 'test', sourceReference: 'https://example.com',
      }],
    }),
    model: {
      async *analyze() {
        yield { type: 'text_delta' as const, text: '正在形成判断' }
        await modelMayFinish
        yield { type: 'completed' as const, report: {
          title: '报告', marketState: '稳定', trend: '震荡', drivers: ['量价'],
          supportingEvidence: ['fact-1'], contraryEvidence: ['fact-1'],
          keyJudgments: [{ judgment: '震荡', evidence: ['fact-1'] }],
          scenarios: [{ name: '基准', condition: '维持', outcome: '震荡' }],
          invalidationConditions: ['跌破'], valuation: null, personalImpact: null,
          conditionalSuggestion: null, limitations: [],
        } }
      },
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'NVDA' }),
  }).then((response) => response.json()) as { analysisId: string }
  const firstController = new AbortController()
  const firstResponse = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`, {
    signal: firstController.signal,
  })
  const reader = firstResponse.body!.getReader()
  const decoder = new TextDecoder()
  let firstStream = ''
  while (!firstStream.includes('event: text_delta')) {
    const chunk = await reader.read()
    if (chunk.done) break
    firstStream += decoder.decode(chunk.value, { stream: true })
  }
  firstController.abort()
  const textDeltaId = Number([...firstStream.matchAll(/id: (\d+)\nevent: text_delta/g)].at(-1)?.[1])
  try {
    assert.ok(Number.isInteger(textDeltaId))
    finishModel!()

    const response = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`, {
      headers: { 'last-event-id': String(textDeltaId) },
    })
    const replayed = await response.text()

    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.doesNotMatch(replayed, /event: queued|event: running|event: text_delta/)
    assert.match(replayed, /event: model_completed/)
    assert.match(replayed, /event: completed/)
    const replayedIds = [...replayed.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]))
    assert.ok(replayedIds.every((id) => id > textDeltaId))
    assert.deepEqual(replayedIds, [...replayedIds].sort((left, right) => left - right))
  } finally {
    finishModel!()
    await app.close()
  }
})

test('SSE 在 PostgreSQL catch-up 与 live 交接窗口不会漏掉终态', async () => {
  const database = createTestProductDatabase()
  const originalList = database.agentEventRepository.list
  let finishModel: (() => void) | undefined
  const modelMayFinish = new Promise<void>((resolve) => { finishModel = resolve })
  let closeCatchUpWindow = false
  database.agentEventRepository.list = async (sessionId, afterSequence) => {
    const staleCatchUp = await originalList(sessionId, afterSequence)
    if (closeCatchUpWindow) {
      closeCatchUpWindow = false
      finishModel!()
      while ((await database.agentEventRepository.getSession(sessionId))?.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    return staleCatchUp
  }
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: {
      async *analyze() {
        await modelMayFinish
        yield { type: 'completed' as const, report: {
          title: '交接测试', marketState: '数据不足', trend: '未知', drivers: [],
          supportingEvidence: [], contraryEvidence: [], keyJudgments: [], scenarios: [],
          invalidationConditions: [], valuation: null, personalImpact: null,
          conditionalSuggestion: null, limitations: ['测试数据为空'],
        } }
      },
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const created = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'HANDOFF' }),
  }).then((response) => response.json()) as { analysisId: string }
  while ((await database.agentEventRepository.getSession(created.analysisId))?.status !== 'running') {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  closeCatchUpWindow = true
  try {
    const response = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`)
    assert.match(await response.text(), /event: partial/)
  } finally {
    finishModel!()
    await app.close()
  }
})
