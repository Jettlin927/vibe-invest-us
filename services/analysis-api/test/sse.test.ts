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
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  const firstController = new AbortController()
  const firstResponse = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
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
  const textDeltaId = [...firstStream.matchAll(/id: ([^\n]+)\nevent: text_delta/g)].at(-1)?.[1]
  try {
    assert.match(textDeltaId ?? '', new RegExp(`^${created.sessionId}:\\d+$`))
    finishModel!()

    const response = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
      headers: { 'last-event-id': textDeltaId! },
    })
    const replayed = await response.text()

    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.doesNotMatch(replayed, /event: queued|event: running|event: text_delta/)
    assert.match(replayed, /event: model_completed/)
    assert.match(replayed, /event: completed/)
    const cursorSequence = Number(textDeltaId!.split(':').at(-1))
    const replayedIds = [...replayed.matchAll(/id: ([^\n]+)/g)].map((match) => match[1]!)
    assert.ok(replayedIds.every((id) => id.startsWith(`${created.sessionId}:`)
      && Number(id.split(':').at(-1)) > cursorSequence))
    const wrongSession = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`, {
      headers: { 'last-event-id': `another-session:${cursorSequence}` },
    })
    assert.equal(wrongSession.status, 400)
    assert.deepEqual(await wrongSession.json(), { error: 'invalid_last_event_id' })
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
  }).then((response) => response.json()) as { analysisId: string; sessionId: string }
  while ((await database.agentEventRepository.getSession(created.sessionId))?.status !== 'running') {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  closeCatchUpWindow = true
  try {
    const response = await fetch(`${baseUrl}/api/agent-sessions/${created.sessionId}/events`)
    assert.match(await response.text(), /event: partial/)
  } finally {
    finishModel!()
    await app.close()
  }
})
