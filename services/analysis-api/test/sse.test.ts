import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildApp as buildProductionApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'

function buildApp(dependencies: Parameters<typeof buildProductionApp>[0]) {
  return buildProductionApp({ ...createTestProductDatabase(), ...dependencies })
}

test('真实 HTTP SSE 在任务完成前依次发送运行进度和终态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-sse-'))
  const app = buildApp({
    databasePath: join(directory, 'app.db'),
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
        await new Promise((resolve) => setTimeout(resolve, 25))
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
  const response = await fetch(`${baseUrl}/api/analyses/${created.analysisId}/events`)
  const stream = await response.text()

  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.ok(stream.indexOf('event: running') < stream.indexOf('event: text_delta'))
  assert.ok(stream.indexOf('event: text_delta') < stream.indexOf('event: completed'))
  await app.close()
})
