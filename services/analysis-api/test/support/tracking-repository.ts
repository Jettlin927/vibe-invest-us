import type {
  TrackingEvent,
  TrackingObservation as Observation,
  TrackingObservationInput as ObservationInput,
  TrackingRun,
  TrackingTarget,
  WatchlistItem,
} from '@vibe-invest/contracts'
import type { TrackingRepository } from '@vibe-invest/product-dao'

export function createTestTrackingRepository() {
  const watchlist = new Map<string, WatchlistItem>()
  const runs = new Map<string, TrackingRun>()
  const observations: Observation[] = []
  const events: TrackingEvent[] = []

  const repository: TrackingRepository = {
    async listWatchlist() {
      return [...watchlist.values()].sort((left, right) => left.symbol.localeCompare(right.symbol))
    },
    async addWatchlist(input: {
      symbol: string; note?: string; enabled?: boolean; createdAt?: string
    }) {
      const timestamp = input.createdAt ?? new Date().toISOString()
      const existing = watchlist.get(input.symbol)
      const item = {
        symbol: input.symbol,
        note: input.note ?? existing?.note ?? '',
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      watchlist.set(item.symbol, item)
      return structuredClone(item)
    },
    async updateWatchlist(
      symbol: string,
      input: { note?: string; enabled?: boolean; updatedAt?: string },
    ) {
      const existing = watchlist.get(symbol)
      if (!existing) return null
      const item = {
        ...existing,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      }
      watchlist.set(symbol, item)
      return structuredClone(item)
    },
    async removeWatchlist(symbol: string) {
      return watchlist.delete(symbol)
    },
    async getActiveRun() {
      return structuredClone([...runs.values()].find(({ status }) => status === 'running') ?? null)
    },
    async beginRun(input: { id: string; targets: TrackingTarget[]; startedAt: string }) {
      if ([...runs.values()].some(({ status }) => status === 'running')) {
        throw new Error('tracking_run_active')
      }
      const run: TrackingRun = {
        ...structuredClone(input), status: 'running', completedAt: null, error: null,
      }
      runs.set(run.id, run)
      return structuredClone(run)
    },
    async getRun(id: string) {
      const run = runs.get(id)
      if (!run) return null
      return {
        ...structuredClone(run),
        observations: structuredClone(observations.filter(({ runId }) => runId === id)),
        events: structuredClone(events.filter(({ runId }) => runId === id)),
      }
    },
    async getLatestRun() {
      const latest = [...runs.values()].sort((left, right) => (
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)
      ))[0]
      return latest ? this.getRun(latest.id) : null
    },
    async latestSuccessfulObservations(symbols?: string[]) {
      const allowed = symbols ? new Set(symbols) : null
      const latest = new Map<string, Observation>()
      for (const observation of observations) {
        if (observation.status !== 'success' || (allowed && !allowed.has(observation.symbol))) continue
        const key = `${observation.symbol}:${observation.capability}`
        const current = latest.get(key)
        if (!current || current.observedAt <= observation.observedAt) latest.set(key, observation)
      }
      return structuredClone([...latest.values()])
    },
    async completeRun(input: {
      runId: string
      status: 'completed' | 'partial' | 'failed'
      observations: ObservationInput[]
      completedAt: string
      error?: string
    }) {
      const run = runs.get(input.runId)
      if (!run) throw new Error('tracking_run_not_found')
      const latest = await this.latestSuccessfulObservations(run.targets.map(({ symbol }) => symbol))
      for (const candidate of input.observations) {
        const baseline = latest.find(({ symbol, capability }) => (
          symbol === candidate.symbol && capability === candidate.capability
        )) ?? null
        const observation: Observation = {
          id: candidate.id,
          runId: input.runId,
          symbol: candidate.symbol,
          capability: candidate.capability,
          status: candidate.status,
          baselineObservationId: baseline?.id ?? null,
          observedAt: candidate.observedAt,
          payload: structuredClone(candidate.payload),
        }
        observations.push(observation)
        if (!baseline) continue
        for (const eventCandidate of candidate.events) {
          if (events.some(({ eventKey }) => eventKey === eventCandidate.eventKey)) continue
          events.push({
            id: crypto.randomUUID(), runId: input.runId, observationId: observation.id,
            baselineObservationId: baseline.id, symbol: observation.symbol,
            capability: observation.capability, createdAt: input.completedAt,
            ...structuredClone(eventCandidate),
          })
        }
      }
      runs.set(input.runId, {
        ...run, status: input.status, completedAt: input.completedAt, error: input.error ?? null,
      })
      return this.getRun(input.runId)
    },
    async listEvents(options: { symbol?: string; limit?: number } = {}) {
      return structuredClone(events.filter(({ symbol }) => !options.symbol || symbol === options.symbol)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, options.limit ?? 100))
    },
  }
  return repository
}
