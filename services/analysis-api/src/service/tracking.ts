import { expandQuoteBatch, buildObservations, projectLatestScan, mergeTargets, type SourceResult } from '@vibe-invest/domain/tracking'
import type { TrackingRepository } from '@vibe-invest/db'
import type {
  TrackingObservationInput as ObservationInput,
  TrackingRun,
} from '@vibe-invest/contracts'

import type {
  FactQueryResult, FinancialFact, QuoteSnapshot,
} from '../adapters/financial-data-client.js'

type TechnicalEvidence = {
  facts: FinancialFact[]
  actualEnd?: unknown
  indicators?: unknown
  volumePrice?: unknown
  [key: string]: unknown
}

type FinancialOverview = {
  facts: FinancialFact[]
  overview: Record<string, unknown>
  sources?: unknown[]
}



type ScanJob = {
  key: string
  fetch: (signal: AbortSignal) => Promise<unknown>
}

const DEFAULT_SCAN_CONCURRENCY = 4

export function createTrackingService(dependencies: {
  repository: TrackingRepository
  listPositionSymbols: () => Promise<string[]>
  fetchTrackingQuotes?: (symbols: string[], signal: AbortSignal) => Promise<QuoteSnapshot[]>
  getTechnicalEvidence?: (symbol: string, signal: AbortSignal) => Promise<TechnicalEvidence>
  getFinancialOverview?: (symbol: string, signal: AbortSignal) => Promise<FinancialOverview>
  listOfficialCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  listCompanyEvents?: (symbol: string, signal: AbortSignal) => Promise<FactQueryResult>
  now?: () => Date
  concurrency?: number
  scanIntervalMs?: number
  afterObservations?: (observations: ObservationInput[], completedAt: string) => Promise<void>
  onBackgroundError?: (error: unknown) => void
}) {
  const scanIntervalMs = dependencies.scanIntervalMs ?? 0
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0 || scanIntervalMs > 2_147_483_647) {
    throw new Error('invalid_tracking_scan_interval')
  }
  const repository = dependencies.repository
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  let schedule: ReturnType<typeof setInterval> | null = null
  const reportBackgroundError = (error: unknown) => {
    if (dependencies.onBackgroundError) dependencies.onBackgroundError(error)
    else console.error('tracking_background_error', error)
  }

  async function startScan() {
    const [watchlist, positionSymbols] = await Promise.all([
      repository.listWatchlist(), dependencies.listPositionSymbols(),
    ])
    const startedAt = currentTime(dependencies.now)
    const run = await repository.beginRun({
      id: crypto.randomUUID(), targets: mergeTargets(watchlist, positionSymbols), startedAt,
    })
    const controller = new AbortController()
    const promise = executeScan(run, controller.signal)
      .catch(reportBackgroundError)
      .finally(() => { running.delete(run.id) })
    running.set(run.id, { controller, promise })
    return run
  }

  return {
    async initialize() {
      const interrupted = await repository.getActiveRun()
      if (interrupted) {
        try {
          await repository.completeRun({
            runId: interrupted.id,
            status: 'failed',
            observations: [],
            completedAt: currentTime(dependencies.now),
            error: 'tracking_run_interrupted',
          })
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'tracking_run_not_active') throw error
        }
      }
      if (scanIntervalMs > 0 && !schedule) {
        schedule = setInterval(() => {
          void Promise.all([repository.listWatchlist(), dependencies.listPositionSymbols()])
            .then(([watchlist, positions]) => {
              if (watchlist.some(({ enabled }) => enabled) || positions.length > 0) return startScan()
              return undefined
            })
            .catch(reportBackgroundError)
        }, scanIntervalMs)
      }
    },
    async state(options: { symbol?: string; limit?: number } = {}) {
      const [watchlist, positionSymbols, activeScan, latestScan, events] = await Promise.all([
        repository.listWatchlist(),
        dependencies.listPositionSymbols(),
        repository.getActiveRun(),
        repository.getLatestRun(),
        repository.listEvents(options),
      ])
      return {
        watchlist,
        targets: mergeTargets(watchlist, positionSymbols),
        activeScan,
        latestScan: projectLatestScan(latestScan),
        events,
      }
    },
    async putWatchlist(symbol: string, input: { note?: string; enabled?: boolean }) {
      const existing = (await repository.listWatchlist()).find((item) => item.symbol === symbol)
      const timestamp = dependencies.now?.().toISOString()
      if (existing) {
        return repository.updateWatchlist(symbol, {
          ...input, ...(timestamp ? { updatedAt: timestamp } : {}),
        })
      }
      return repository.addWatchlist({
        symbol, ...input, ...(timestamp ? { createdAt: timestamp } : {}),
      })
    },
    removeWatchlist(symbol: string) {
      return repository.removeWatchlist(symbol)
    },
    startScan,
    getScan(id: string) {
      return repository.getRun(id)
    },
    async close() {
      if (schedule) clearInterval(schedule)
      schedule = null
      for (const active of running.values()) active.controller.abort('tracking_service_closing')
      await Promise.allSettled([...running.values()].map(({ promise }) => promise))
    },
  }

  async function executeScan(run: TrackingRun, signal: AbortSignal) {
    try {
      const baselines = await repository.latestSuccessfulObservations(
        run.targets.map(({ symbol }) => symbol),
      )
      const symbols = run.targets.map(({ symbol }) => symbol)
      const jobs = createJobs(symbols)
      const results = await mapWithConcurrency(
        jobs,
        Math.max(1, Math.floor(dependencies.concurrency ?? DEFAULT_SCAN_CONCURRENCY)),
        async (job): Promise<[string, SourceResult<unknown>]> => {
          try {
            return [job.key, { ok: true, value: await job.fetch(signal) }]
          } catch (error) {
            return [job.key, { ok: false, error: safeError(error) }]
          }
        },
      )
      const bySource = new Map(results)
      expandQuoteBatch(symbols, bySource)
      const observations = run.targets.flatMap(({ symbol }) => buildObservations(
        symbol, bySource, baselines, currentTime(dependencies.now),
      ))
      const successful = observations.filter(({ status }) => status === 'success').length
      const gaps = observations.length - successful
      let status: 'completed' | 'partial' | 'failed' = gaps === 0
        ? 'completed' : successful === 0 ? 'failed' : 'partial'
      const completedAt = currentTime(dependencies.now)
      let protectionError: string | undefined
      try {
        await dependencies.afterObservations?.(observations, completedAt)
      } catch {
        protectionError = 'profit_protection_evaluation_failed'
        if (status === 'completed') status = 'partial'
      }
      await repository.completeRun({
        runId: run.id,
        status,
        observations,
        completedAt,
        ...(status === 'failed' ? { error: 'tracking_data_unavailable' }
          : protectionError ? { error: protectionError } : {}),
      })
    } catch (error) {
      await repository.completeRun({
        runId: run.id,
        status: 'failed',
        observations: [],
        completedAt: currentTime(dependencies.now),
        error: safeError(error),
      })
    }
  }

  function createJobs(symbols: string[]): ScanJob[] {
    if (symbols.length === 0) return []
    const quoteJob: ScanJob = {
      key: 'quotes',
      fetch: (signal) => required(dependencies.fetchTrackingQuotes, 'tracking_quote_unavailable')(
        symbols, signal,
      ),
    }
    return [quoteJob, ...symbols.flatMap((symbol): ScanJob[] => [
      {
        key: `${symbol}:technical`,
        fetch: (signal) => required(dependencies.getTechnicalEvidence, 'tracking_technical_unavailable')(
          symbol, signal,
        ),
      },
      {
        key: `${symbol}:fundamental`,
        fetch: (signal) => required(dependencies.getFinancialOverview, 'tracking_fundamental_unavailable')(
          symbol, signal,
        ),
      },
      {
        key: `${symbol}:official`,
        fetch: (signal) => required(
          dependencies.listOfficialCompanyEvents, 'tracking_official_events_unavailable',
        )(symbol, signal),
      },
      {
        key: `${symbol}:news`,
        fetch: (signal) => required(dependencies.listCompanyEvents, 'tracking_news_unavailable')(
          symbol, signal,
        ),
      },
    ])]
  }
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[], concurrency: number, task: (input: Input) => Promise<Output>,
) {
  const output = new Array<Output>(inputs.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (cursor < inputs.length) {
      const index = cursor
      cursor += 1
      output[index] = await task(inputs[index]!)
    }
  })
  await Promise.all(workers)
  return output
}

function required<Args extends unknown[], Result>(
  dependency: ((...args: Args) => Promise<Result>) | undefined,
  error: string,
) {
  if (!dependency) return async (..._args: Args): Promise<Result> => { throw new Error(error) }
  return dependency
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(message) ? message : 'tracking_source_unavailable'
}

function currentTime(now?: () => Date) {
  return (now?.() ?? new Date()).toISOString()
}
