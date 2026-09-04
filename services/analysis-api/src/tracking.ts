import type { TrackingRepository } from '@vibe-invest/product-dao'
import type {
  TrackingCapability as Capability,
  TrackingEventCandidate as EventCandidate,
  TrackingEventSeverity as EventSeverity,
  TrackingObservation as StoredObservation,
  TrackingObservationInput as ObservationInput,
  TrackingRun,
  TrackingTarget,
} from '@vibe-invest/contracts'

import type {
  FactQueryResult, FinancialFact, QuoteSnapshot,
} from './financial-data-client.js'

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

type SourceResult<T> = { ok: true; value: T } | { ok: false; error: string }

type ScanJob = {
  key: string
  fetch: (signal: AbortSignal) => Promise<unknown>
}

const PRICE_MOVE_THRESHOLD = 0.05
const VOLUME_RATIO_THRESHOLD = 1.5
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
}) {
  const repository = dependencies.repository
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  let schedule: ReturnType<typeof setInterval> | null = null

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
      .catch(() => {})
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
      if (dependencies.scanIntervalMs && dependencies.scanIntervalMs > 0 && !schedule) {
        schedule = setInterval(() => {
          void Promise.all([repository.listWatchlist(), dependencies.listPositionSymbols()])
            .then(([watchlist, positions]) => {
              if (watchlist.some(({ enabled }) => enabled) || positions.length > 0) return startScan()
              return undefined
            })
            .catch(() => {})
        }, dependencies.scanIntervalMs)
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
      const status = gaps === 0 ? 'completed' : successful === 0 ? 'failed' : 'partial'
      const completedAt = currentTime(dependencies.now)
      try {
        await dependencies.afterObservations?.(observations, completedAt)
      } catch {
        // Profit-protection evaluation must not turn a valid market scan into a failure.
      }
      await repository.completeRun({
        runId: run.id,
        status,
        observations,
        completedAt,
        ...(status === 'failed' ? { error: 'tracking_data_unavailable' } : {}),
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

function expandQuoteBatch(symbols: string[], results: Map<string, SourceResult<unknown>>) {
  const batch = results.get('quotes')
  for (const symbol of symbols) {
    if (!batch?.ok || !Array.isArray(batch.value)) {
      results.set(`${symbol}:quote`, batch?.ok
        ? { ok: false, error: 'tracking_quote_contract_invalid' }
        : batch ?? { ok: false, error: 'tracking_quote_unavailable' })
      continue
    }
    const quote = batch.value.find((candidate) => isRecord(candidate) && candidate.symbol === symbol)
    results.set(`${symbol}:quote`, quote && typeof quote.price === 'number'
      ? { ok: true, value: quote }
      : { ok: false, error: 'tracking_quote_unavailable' })
  }
}

function buildObservations(
  symbol: string,
  sources: Map<string, SourceResult<unknown>>,
  baselines: StoredObservation[],
  fallbackObservedAt: string,
): ObservationInput[] {
  const quote = sources.get(`${symbol}:quote`)!
  const technical = sources.get(`${symbol}:technical`)!
  const fundamental = sources.get(`${symbol}:fundamental`)!
  const official = sources.get(`${symbol}:official`)!
  const news = sources.get(`${symbol}:news`)!
  const baselineFor = (capability: Capability) => baselines.find((candidate) => (
    candidate.symbol === symbol && candidate.capability === capability
  ))
  const quoteRecord = quote.ok && isRecord(quote.value) ? quote.value : null
  const technicalRecord = technical.ok && isRecord(technical.value) ? technical.value : null
  const indicatorRecord = recordAt(technicalRecord, 'indicators')
  const volumeRecord = recordAt(technicalRecord, 'volumePrice')

  const technicalPayload: Record<string, unknown> = {
    quote: quoteRecord ? {
      price: numberValue(quoteRecord.price), observedAt: stringValue(quoteRecord.observedAt),
      source: stringValue(quoteRecord.source),
      sourceReference: stringValue(quoteRecord.sourceReference),
    } : null,
    technical: technicalRecord ? {
      actualEnd: stringValue(technicalRecord.actualEnd),
      indicators: {
        ma_5: numberValue(indicatorRecord?.ma_5),
        ma_20: numberValue(indicatorRecord?.ma_20),
        rsi_14: numberValue(indicatorRecord?.rsi_14),
      },
      volumePrice: { volumeRatio5To20: numberValue(volumeRecord?.volumeRatio5To20) },
      facts: asFacts(technicalRecord.facts).slice(0, 1).map((fact) => compactFact(fact)),
    } : null,
    gaps: gapsFromSources({ quote, technical }),
  }
  const technicalStatus = sourceAvailable(quote) && sourceAvailable(technical)
    ? 'success' : 'data_gap'
  const technicalObservedAt = quote.ok && isRecord(quote.value)
    && typeof quote.value.observedAt === 'string'
    ? quote.value.observedAt
    : technical.ok && isRecord(technical.value) && typeof technical.value.actualEnd === 'string'
      ? technical.value.actualEnd : fallbackObservedAt

  const fundamentalRecord = fundamental.ok && isRecord(fundamental.value)
    ? fundamental.value : null
  const overviewRecord = fundamentalRecord && isRecord(fundamentalRecord.overview)
    ? fundamentalRecord.overview : null
  const fundamentalPayload: Record<string, unknown> = {
    overview: overviewRecord ? {
      latestPeriod: stringValue(overviewRecord.latestPeriod),
      qualityFlags: arrayAt(overviewRecord, 'qualityFlags').filter(isRecord).map((flag) => ({
        flag_type: stringValue(flag.flag_type ?? flag.flagType),
        severity: stringValue(flag.severity), period: stringValue(flag.period),
      })),
    } : null,
    facts: asFacts(fundamentalRecord?.facts).map((fact) => compactFact(fact)),
    officialEvents: official.ok && isRecord(official.value)
      ? asFacts(official.value.facts).map((fact) => compactFact(
          fact, ['filingId', 'form', 'title'],
        )) : [],
    gaps: gapsFromSources({ fundamental, official }, true),
  }
  const fundamentalStatus = sourceAvailable(fundamental, true) && sourceAvailable(official, true)
    ? 'success' : 'data_gap'
  const fundamentalObservedAt = latestFactTime(
    [...asFacts(fundamentalPayload.facts), ...asFacts(fundamentalPayload.officialEvents)],
    fallbackObservedAt,
  )

  const newsPayload: Record<string, unknown> = {
    headlines: news.ok && isRecord(news.value)
      ? asFacts(news.value.facts).map((fact) => compactFact(fact, ['title'])) : [],
    gaps: gapsFromSources({ news }, true),
  }
  const newsStatus = sourceAvailable(news, true) ? 'success' : 'data_gap'
  const newsObservedAt = latestFactTime(asFacts(newsPayload.headlines), fallbackObservedAt)

  return [
    observation(symbol, 'technical', technicalStatus, technicalObservedAt, technicalPayload,
      baselineFor('technical')),
    observation(symbol, 'fundamental', fundamentalStatus, fundamentalObservedAt, fundamentalPayload,
      baselineFor('fundamental')),
    observation(symbol, 'news', newsStatus, newsObservedAt, newsPayload, baselineFor('news')),
  ]
}

function observation(
  symbol: string,
  capability: Capability,
  status: StoredObservation['status'],
  observedAt: string,
  payload: Record<string, unknown>,
  baseline?: StoredObservation,
): ObservationInput {
  return {
    id: crypto.randomUUID(), symbol, capability, status, observedAt, payload,
    events: status === 'success' && baseline
      ? detectEvents(symbol, capability, observedAt, baseline.payload, payload)
      : [],
  }
}

function detectEvents(
  symbol: string,
  capability: Capability,
  observedAt: string,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  if (capability === 'technical') return technicalEvents(symbol, observedAt, previous, current)
  if (capability === 'fundamental') return fundamentalEvents(symbol, observedAt, previous, current)
  return newsEvents(symbol, observedAt, previous, current)
}

function technicalEvents(
  symbol: string, observedAt: string,
  previous: Record<string, unknown>, current: Record<string, unknown>,
): EventCandidate[] {
  const events: EventCandidate[] = []
  const previousQuote = numberAt(previous, 'quote', 'price')
  const currentQuote = numberAt(current, 'quote', 'price')
  const currentQuoteRecord = recordAt(current, 'quote')
  const currentTechnicalRecord = recordAt(current, 'technical')
  const priceObservedAt = stringValue(currentQuoteRecord?.observedAt) ?? observedAt
  const indicatorObservedAt = stringValue(currentTechnicalRecord?.actualEnd) ?? observedAt
  const priceEvidence = compactEvidence(currentQuoteRecord)
  const technicalEvidence = compactEvidence(asFacts(currentTechnicalRecord?.facts)[0])
  if (previousQuote !== null && previousQuote > 0 && currentQuote !== null) {
    const change = currentQuote / previousQuote - 1
    if (Math.abs(change) >= PRICE_MOVE_THRESHOLD) {
      events.push(event(
        symbol, 'price_move', priceObservedAt,
        Math.abs(change) >= PRICE_MOVE_THRESHOLD * 2 ? 'critical' : 'warning',
        { previous: previousQuote, current: currentQuote, change, evidence: priceEvidence },
      ))
    }
  }

  const previousMa5 = numberAt(previous, 'technical', 'indicators', 'ma_5')
  const previousMa20 = numberAt(previous, 'technical', 'indicators', 'ma_20')
  const currentMa5 = numberAt(current, 'technical', 'indicators', 'ma_5')
  const currentMa20 = numberAt(current, 'technical', 'indicators', 'ma_20')
  if ([previousMa5, previousMa20, currentMa5, currentMa20].every((value) => value !== null)) {
    const previousDirection = Math.sign(previousMa5! - previousMa20!)
    const currentDirection = Math.sign(currentMa5! - currentMa20!)
    if (previousDirection !== 0 && currentDirection !== 0 && previousDirection !== currentDirection) {
      events.push(event(symbol, 'ma_cross', indicatorObservedAt, 'warning', {
        direction: currentDirection > 0 ? 'bullish' : 'bearish',
        previous: { ma5: previousMa5, ma20: previousMa20 },
        current: { ma5: currentMa5, ma20: currentMa20 },
        evidence: technicalEvidence,
      }))
    }
  }

  const previousRsi = numberAt(previous, 'technical', 'indicators', 'rsi_14')
  const currentRsi = numberAt(current, 'technical', 'indicators', 'rsi_14')
  if (previousRsi !== null && currentRsi !== null && rsiZone(previousRsi) !== rsiZone(currentRsi)) {
    const zone = rsiZone(currentRsi)
    events.push(event(symbol, 'rsi_zone', indicatorObservedAt, zone === 'neutral' ? 'info' : 'warning', {
      previous: { value: previousRsi, zone: rsiZone(previousRsi) },
      current: { value: currentRsi, zone },
      evidence: technicalEvidence,
    }))
  }

  const previousVolume = numberAt(previous, 'technical', 'volumePrice', 'volumeRatio5To20')
  const currentVolume = numberAt(current, 'technical', 'volumePrice', 'volumeRatio5To20')
  if (previousVolume !== null && currentVolume !== null
    && previousVolume < VOLUME_RATIO_THRESHOLD && currentVolume >= VOLUME_RATIO_THRESHOLD) {
    events.push(event(symbol, 'volume_spike', indicatorObservedAt, 'warning', {
      previous: previousVolume, current: currentVolume, threshold: VOLUME_RATIO_THRESHOLD,
      evidence: technicalEvidence,
    }))
  }
  return events
}

function fundamentalEvents(
  symbol: string, observedAt: string,
  previous: Record<string, unknown>, current: Record<string, unknown>,
): EventCandidate[] {
  const events: EventCandidate[] = []
  const currentFinancialFacts = asFacts(current.facts)
  const financialObservedAt = latestFactTime(currentFinancialFacts, observedAt)
  const financialEvidence = compactEvidence(
    [...currentFinancialFacts].sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0],
  )
  const previousOverview = recordAt(previous, 'overview')
  const currentOverview = recordAt(current, 'overview')
  const previousPeriod = stringValue(previousOverview?.latestPeriod)
  const currentPeriod = stringValue(currentOverview?.latestPeriod)
  if (currentPeriod && previousPeriod !== currentPeriod) {
    events.push(event(symbol, 'financial_period', financialObservedAt, 'info', {
      previous: previousPeriod, current: currentPeriod, evidence: financialEvidence,
    }, currentPeriod))
  }

  const previousFlags = arrayAt(previousOverview, 'qualityFlags').filter(isRecord)
  const currentFlags = arrayAt(currentOverview, 'qualityFlags').filter(isRecord)
  const previousFlagKeys = new Set(previousFlags.map(flagKey))
  for (const flag of currentFlags) {
    const key = flagKey(flag)
    if (previousFlagKeys.has(key)) continue
    events.push(event(symbol, 'financial_quality_flag', financialObservedAt, flagSeverity(flag), {
      flag, evidence: financialEvidence,
    }, key))
  }

  const previousOfficial = new Set(asFacts(previous.officialEvents).map(factIdentity))
  for (const fact of asFacts(current.officialEvents)) {
    const identity = factIdentity(fact)
    if (previousOfficial.has(identity)) continue
    events.push(event(symbol, 'official_event', fact.observedAt || observedAt, 'warning', {
      fact,
    }, identity))
  }
  return events
}

function newsEvents(
  symbol: string, observedAt: string,
  previous: Record<string, unknown>, current: Record<string, unknown>,
): EventCandidate[] {
  const previousTitles = new Set(asFacts(previous.headlines).map(factTitle).filter(Boolean))
  return asFacts(current.headlines).flatMap((fact) => {
    const title = factTitle(fact)
    if (!title || previousTitles.has(title)) return []
    return [event(symbol, 'news_title', fact.observedAt || observedAt, 'info', { fact }, title)]
  })
}

function event(
  symbol: string,
  kind: string,
  occurredAt: string,
  severity: EventSeverity,
  payload: Record<string, unknown>,
  identity = occurredAt,
): EventCandidate {
  return { eventKey: `${symbol}:${kind}:${identity}`, kind, severity, occurredAt, payload }
}

function projectLatestScan(scan: Awaited<ReturnType<TrackingRepository['getLatestRun']>>) {
  if (!scan) return null
  return {
    ...scan,
    events: [],
    observations: scan.observations.map((observation) => ({
      ...observation,
      payload: {
        gaps: Array.isArray(observation.payload.gaps)
          ? observation.payload.gaps.flatMap((gap) => {
              if (!isRecord(gap)
                || typeof gap.source !== 'string'
                || typeof gap.reason !== 'string') return []
              return [{ source: gap.source, reason: gap.reason }]
            })
          : [],
      },
    })),
  }
}

function mergeTargets(
  watchlist: Array<{ symbol: string; enabled: boolean }>,
  positionSymbols: string[],
) {
  const sources = new Map<string, Set<'watchlist' | 'position'>>()
  for (const item of watchlist) {
    if (item.enabled) sources.set(item.symbol, new Set(['watchlist']))
  }
  for (const symbol of positionSymbols) {
    const targetSources = sources.get(symbol) ?? new Set<'watchlist' | 'position'>()
    targetSources.add('position')
    sources.set(symbol, targetSources)
  }
  return [...sources.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, targetSources]) => ({ symbol, sources: [...targetSources] }))
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

function gapsFromSources(
  sources: Record<string, SourceResult<unknown>>, emptySourcesUnavailable = false,
) {
  return Object.entries(sources).flatMap(([source, result]) => (
    !result.ok
      ? [{ source, reason: result.error }]
      : allSourcesFailed(result.value, emptySourcesUnavailable)
        ? [{ source, reason: 'all_sources_failed' }]
        : []
  ))
}

function sourceAvailable(result: SourceResult<unknown>, emptySourcesUnavailable = false) {
  return result.ok && !allSourcesFailed(result.value, emptySourcesUnavailable)
}

function allSourcesFailed(value: unknown, emptySourcesUnavailable = false) {
  if (!isRecord(value) || !Array.isArray(value.sources)) return false
  if (value.sources.length === 0) return emptySourcesUnavailable
  return value.sources.every((source) => isRecord(source) && source.status === 'failed')
}

function latestFactTime(facts: FinancialFact[], fallback: string) {
  return facts.map(({ observedAt }) => observedAt).sort().at(-1) ?? fallback
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(message) ? message : 'tracking_source_unavailable'
}

function currentTime(now?: () => Date) {
  return (now?.() ?? new Date()).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function recordAt(value: unknown, ...path: string[]) {
  let current: unknown = value
  for (const part of path) {
    if (!isRecord(current)) return null
    current = current[part]
  }
  return isRecord(current) ? current : null
}

function numberAt(value: unknown, ...path: string[]) {
  let current: unknown = value
  for (const part of path) {
    if (!isRecord(current)) return null
    current = current[part]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null
}

function arrayAt(value: unknown, key: string) {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : []
}

function asFacts(value: unknown): FinancialFact[] {
  return Array.isArray(value) ? value.filter((fact): fact is FinancialFact => (
    isRecord(fact) && typeof fact.id === 'string' && typeof fact.observedAt === 'string'
  )) : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compactFact(fact: FinancialFact, valueKeys: string[] = []) {
  const value = isRecord(fact.value) ? fact.value : {}
  return {
    id: fact.id, type: fact.type, observedAt: fact.observedAt,
    fetchedAt: fact.fetchedAt, source: fact.source, sourceReference: fact.sourceReference,
    value: Object.fromEntries(valueKeys.flatMap((key) => (
      value[key] === undefined ? [] : [[key, value[key]]]
    ))),
  }
}

function rsiZone(value: number) {
  if (value <= 30) return 'oversold'
  if (value >= 70) return 'overbought'
  return 'neutral'
}

function flagKey(flag: Record<string, unknown>) {
  return [flag.flag_type ?? flag.flagType ?? '', flag.severity ?? '', flag.period ?? '']
    .map(String).join(':')
}

function flagSeverity(flag: Record<string, unknown>): EventSeverity {
  const severity = String(flag.severity ?? '').toLowerCase()
  if (['critical', 'high', 'error'].includes(severity)) return 'critical'
  if (['warning', 'medium', 'warn'].includes(severity)) return 'warning'
  return 'info'
}

function factIdentity(fact: FinancialFact) {
  const value = isRecord(fact.value) ? fact.value : {}
  return String(value.filingId ?? fact.id)
}

function factTitle(fact: FinancialFact) {
  const value = isRecord(fact.value) ? fact.value : {}
  return typeof value.title === 'string' ? value.title.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

function compactEvidence(value: unknown) {
  if (!isRecord(value)) return null
  const source = stringValue(value.source)
  const sourceReference = stringValue(value.sourceReference)
  const observedAt = stringValue(value.observedAt)
  const fetchedAt = stringValue(value.fetchedAt)
  if (!source && !sourceReference && !observedAt && !fetchedAt) return null
  return { source, sourceReference, observedAt, fetchedAt }
}
