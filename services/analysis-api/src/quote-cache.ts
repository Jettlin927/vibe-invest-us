import type { QuoteSnapshot } from './financial-data-client.js'

export type QuoteBatch = {
  snapshots: QuoteSnapshot[]
  fetchedAt: number
  cached: boolean
}

export function pricesFromSnapshots(snapshots: QuoteSnapshot[]): Record<string, number> {
  return Object.fromEntries(snapshots.flatMap((quote) => (
    typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price >= 0
      ? [[quote.symbol, quote.price] as const] : []
  )))
}

/**
 * 行情读取缓存：同一批标的在 TTL 内复用一次上游结果，并发的相同请求合并为一次调用。
 *
 * 组合页一次加载会同时需要 /api/portfolio 与 /api/profit-protection 的行情，
 * 没有缓存时会对行情服务重复取价；这里让两者共用同一批结果。
 * 手动刷新（force）绕过缓存，但仍会并入已经发出、尚未返回的那次请求。
 */
export function createQuoteCache(
  load: (symbols: string[], signal?: AbortSignal) => Promise<QuoteSnapshot[]>,
  options: { ttlMs: number; now?: () => number },
) {
  const entries = new Map<string, { snapshots: QuoteSnapshot[]; fetchedAt: number }>()
  const pending = new Map<string, Promise<QuoteBatch>>()
  const now = options.now ?? (() => Date.now())
  const keyFor = (symbols: string[]) => [...symbols].sort().join(',')
  return {
    async read(
      symbols: string[], signal?: AbortSignal, readOptions: { force?: boolean } = {},
    ): Promise<QuoteBatch> {
      const key = keyFor(symbols)
      const cached = entries.get(key)
      const current = now()
      if (!readOptions.force && cached && current - cached.fetchedAt < options.ttlMs) {
        return { snapshots: cached.snapshots, fetchedAt: cached.fetchedAt, cached: true }
      }
      const running = pending.get(key)
      if (running) return running
      const request = load(symbols, signal).then((snapshots) => {
        const fetchedAt = now()
        entries.set(key, { snapshots, fetchedAt })
        return { snapshots, fetchedAt, cached: false }
      })
      pending.set(key, request)
      // 失败不写缓存，并释放合并位；错误仍由发起方处理。
      request.catch(() => undefined).finally(() => {
        if (pending.get(key) === request) pending.delete(key)
      })
      return request
    },
  }
}
