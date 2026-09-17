import assert from 'node:assert/strict'
import test from 'node:test'

import type { QuoteSnapshot } from '../src/financial-data-client.js'
import { createQuoteCache, pricesFromSnapshots } from '../src/quote-cache.js'

function quote(symbol: string, price: number, source = 'tencent'): QuoteSnapshot {
  return {
    symbol, price, observedAt: '2026-03-05T14:00:00.000Z', source, degraded: false, sources: [],
  }
}

test('行情缓存在 TTL 内复用同一批结果', async () => {
  let now = 0
  let loads = 0
  const cache = createQuoteCache(async (symbols) => {
    loads += 1
    return symbols.map((symbol) => quote(symbol, 100))
  }, { ttlMs: 10_000, now: () => now })

  const first = await cache.read(['NVDA'])
  const second = await cache.read(['NVDA'])

  assert.equal(loads, 1)
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  now = 10_001
  await cache.read(['NVDA'])
  assert.equal(loads, 2)
})

test('手动刷新绕过缓存但仍沿用同一批标的的键', async () => {
  let loads = 0
  const cache = createQuoteCache(async (symbols) => {
    loads += 1
    return symbols.map((symbol) => quote(symbol, 100 + loads))
  }, { ttlMs: 10_000 })

  await cache.read(['NVDA', 'MSFT'])
  const forced = await cache.read(['MSFT', 'NVDA'], undefined, { force: true })

  assert.equal(loads, 2)
  assert.equal(forced.cached, false)
  assert.equal(forced.snapshots[0]?.price ? true : false, true)
})

test('并发读取同一批标的只触发一次上游调用', async () => {
  let loads = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const cache = createQuoteCache(async (symbols) => {
    loads += 1
    await gate
    return symbols.map((symbol) => quote(symbol, 120))
  }, { ttlMs: 10_000 })

  const requests = [cache.read(['NVDA']), cache.read(['NVDA']), cache.read(['NVDA'])]
  release()
  const results = await Promise.all(requests)

  assert.equal(loads, 1)
  assert.deepEqual(results.map((result) => result.cached), [false, false, false])
})

test('上游失败不写入缓存，下一次读取会重试', async () => {
  let loads = 0
  const cache = createQuoteCache(async (symbols) => {
    loads += 1
    if (loads === 1) throw new Error('quotes_unavailable')
    return symbols.map((symbol) => quote(symbol, 120))
  }, { ttlMs: 10_000 })

  await assert.rejects(() => cache.read(['NVDA']))
  const recovered = await cache.read(['NVDA'])

  assert.equal(loads, 2)
  assert.equal(recovered.cached, false)
  assert.equal(recovered.snapshots[0]?.price, 120)
})

test('快照价格表忽略缺失与非有限价格', () => {
  const prices = pricesFromSnapshots([
    quote('NVDA', 120),
    { ...quote('MSFT', 0), price: null },
    { ...quote('AMD', 0), price: Number.NaN },
    { ...quote('TSLA', 0), price: -3 },
  ])

  assert.deepEqual(prices, { NVDA: 120 })
})
