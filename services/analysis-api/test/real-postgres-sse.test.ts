import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkSchema,
  createAgentEventRepository,
  createAnalysisRepository,
  createPool,
  createPortfolioRepository,
} from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import type { ModelEvent } from '../src/model.js'

const databaseUrl = process.env.TEST_DATABASE_URL

test('真实 PostgreSQL 与真实 HTTP SSE 断线后先 catch-up 再继续 live', {
  skip: !databaseUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(databaseUrl!)
  const eventRepository = createAgentEventRepository(pool)
  let writeMissedEvent: (() => void) | undefined
  let finishModel: (() => void) | undefined
  const missedEventMayWrite = new Promise<void>((resolve) => { writeMissedEvent = resolve })
  const modelMayFinish = new Promise<void>((resolve) => { finishModel = resolve })
  const app = buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool),
    analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: eventRepository,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    fetchFinancialContext: async (symbol) => ({ symbol, gaps: [], facts: [] }),
    model: {
      async *analyze(): AsyncGenerator<ModelEvent> {
        yield { type: 'text_delta', text: 'first-connection' }
        await missedEventMayWrite
        yield { type: 'text_delta', text: 'persisted-while-disconnected' }
        await modelMayFinish
        yield { type: 'completed', report: {
          title: 'SSE 回放测试', marketState: '数据不足', trend: '未知', drivers: [],
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
    body: JSON.stringify({ symbol: 'PGSSE' }),
  }).then((response) => response.json()) as { analysisId: string }

  try {
    const firstController = new AbortController()
    const firstResponse = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`, {
      signal: firstController.signal,
    })
    const first = await readThrough(firstResponse, 'first-connection')
    const lastEventId = Number([...first.matchAll(/id: (\d+)/g)].at(-1)?.[1])
    assert.ok(Number.isSafeInteger(lastEventId))
    firstController.abort()

    writeMissedEvent!()
    await waitForPersistedEvent(eventRepository, created.analysisId, 'persisted-while-disconnected')

    const secondResponse = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`, {
      headers: { 'last-event-id': String(lastEventId) },
    })
    const secondReader = secondResponse.body!.getReader()
    const catchUp = await readThroughReader(secondReader, 'persisted-while-disconnected')
    assert.doesNotMatch(catchUp, /first-connection/)
    assert.match(catchUp, /persisted-while-disconnected/)

    finishModel!()
    const live = await readThroughReader(secondReader, 'event: partial')
    assert.match(live, /event: model_completed/)
    assert.match(live, /event: partial/)
    const ids = [...`${catchUp}${live}`.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]))
    assert.ok(ids.every((id) => id > lastEventId))
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right))
  } finally {
    writeMissedEvent!()
    finishModel!()
    await app.close()
  }
})

async function readThrough(response: Response, marker: string) {
  return readThroughReader(response.body!.getReader(), marker)
}

async function readThroughReader(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(marker)) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text
}

async function waitForPersistedEvent(
  repository: ReturnType<typeof createAgentEventRepository>,
  sessionId: string,
  text: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await repository.list(sessionId, 0)).some(({ payload }) => payload.text === text)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('agent_event_not_persisted')
}
