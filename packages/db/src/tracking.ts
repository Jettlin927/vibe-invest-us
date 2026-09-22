import { assertActiveExecution } from './execution-guard.js'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type TrackingEvent, type TrackingObservation, type TrackingObservationInput, type TrackingRun, type TrackingRunDetail, type TrackingTarget, type TrackingTargetSource, type WatchlistItem } from '@vibe-invest/contracts'

type WatchlistItemRow = {
  symbol: string
  note: string
  enabled: boolean
  created_at: string
  updated_at: string
}

type TrackingRunRow = {
  id: string
  status: TrackingRun['status']
  targets_json: TrackingTarget[]
  started_at: string
  completed_at: string | null
  error: string | null
}

type TrackingObservationRow = {
  id: string
  run_id: string
  symbol: string
  capability: TrackingObservation['capability']
  status: TrackingObservation['status']
  baseline_observation_id: string | null
  observed_at: string
  payload_json: Record<string, unknown>
}

type TrackingEventRow = {
  id: string
  run_id: string
  observation_id: string
  baseline_observation_id: string
  event_key: string
  symbol: string
  capability: TrackingEvent['capability']
  kind: string
  severity: TrackingEvent['severity']
  occurred_at: string
  payload_json: Record<string, unknown>
  created_at: string
}

function normalizeTrackingSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase()
  if (!normalized) throw new Error('invalid_tracking_symbol')
  return normalized
}

function mapWatchlistItem(row: WatchlistItemRow): WatchlistItem {
  return {
    symbol: row.symbol,
    note: row.note,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function normalizeTrackingTargets(targets: TrackingTarget[]): TrackingTarget[] {
  return targets.map((target) => {
    const sources = [...new Set(target.sources)]
    if (sources.some((source) => source !== 'watchlist' && source !== 'position')) {
      throw new Error('invalid_tracking_target_source')
    }
    return {
      symbol: normalizeTrackingSymbol(target.symbol),
      sources: sources as TrackingTargetSource[],
    }
  })
}

function mapTrackingRun(row: TrackingRunRow): TrackingRun {
  return {
    id: row.id,
    status: row.status,
    targets: row.targets_json,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    error: row.error,
  }
}

function mapTrackingObservation(row: TrackingObservationRow): TrackingObservation {
  return {
    id: row.id,
    runId: row.run_id,
    symbol: row.symbol,
    capability: row.capability,
    status: row.status,
    baselineObservationId: row.baseline_observation_id,
    observedAt: row.observed_at,
    payload: row.payload_json,
  }
}

function mapTrackingEvent(row: TrackingEventRow): TrackingEvent {
  return {
    id: row.id,
    runId: row.run_id,
    observationId: row.observation_id,
    baselineObservationId: row.baseline_observation_id,
    eventKey: row.event_key,
    symbol: row.symbol,
    capability: row.capability,
    kind: row.kind,
    severity: row.severity,
    occurredAt: row.occurred_at,
    payload: row.payload_json,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const trackingRunColumns = `
  id, status, targets_json, started_at::text, completed_at::text, error
`

const trackingObservationColumns = `
  id, run_id, symbol, capability, status, baseline_observation_id,
  observed_at::text, payload_json
`

const trackingEventColumns = `
  id, run_id, observation_id, baseline_observation_id, event_key, symbol,
  capability, kind, severity, occurred_at::text, payload_json, created_at::text
`

async function readTrackingRunDetail(
  database: Pool | PoolClient, runId: string,
): Promise<TrackingRunDetail | null> {
  const [run, observations, events] = await Promise.all([
    database.query<TrackingRunRow>(
      `SELECT ${trackingRunColumns} FROM tracking_runs WHERE id = $1`, [runId],
    ),
    database.query<TrackingObservationRow>(
      `SELECT ${trackingObservationColumns} FROM tracking_observations
       WHERE run_id = $1 ORDER BY symbol, capability, observed_at, id`, [runId],
    ),
    database.query<TrackingEventRow>(
      `SELECT ${trackingEventColumns} FROM tracking_events
       WHERE run_id = $1 ORDER BY occurred_at, id`, [runId],
    ),
  ])
  if (!run.rows[0]) return null
  return {
    ...mapTrackingRun(run.rows[0]),
    observations: observations.rows.map(mapTrackingObservation),
    events: events.rows.map(mapTrackingEvent),
  }
}

export function createTrackingRepository(pool: Pool) {
  return {
    async setWatchlistItem(symbol: string, input: { enabled: boolean; note?: string }, executionId?: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (input.enabled) await client.query(
          `INSERT INTO watchlist_items (symbol, note, enabled, created_at, updated_at)
           VALUES ($1, $2, true, now(), now())
           ON CONFLICT (symbol) DO UPDATE SET enabled = true,
             note = CASE WHEN $3::boolean THEN excluded.note ELSE watchlist_items.note END, updated_at = now()`,
          [symbol, input.note ?? '', input.note !== undefined],
        )
        else await client.query('DELETE FROM watchlist_items WHERE symbol = $1', [symbol])
        await assertActiveExecution(client, executionId)
        const result = await client.query<WatchlistItemRow>(
          'SELECT symbol, note, enabled, created_at::text, updated_at::text FROM watchlist_items WHERE symbol = $1', [symbol],
        )
        await client.query('COMMIT')
        return result.rows[0] ? mapWatchlistItem(result.rows[0]) : null
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    },
    async listWatchlist(): Promise<WatchlistItem[]> {
      const result = await pool.query<WatchlistItemRow>(
        `SELECT symbol, note, enabled, created_at::text, updated_at::text
         FROM watchlist_items ORDER BY symbol`,
      )
      return result.rows.map(mapWatchlistItem)
    },
    async addWatchlist(input: {
      symbol: string; note?: string; enabled?: boolean; createdAt?: string
    }): Promise<WatchlistItem> {
      const createdAt = input.createdAt ?? new Date().toISOString()
      const result = await pool.query<WatchlistItemRow>(
        `INSERT INTO watchlist_items (symbol, note, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (symbol) DO NOTHING
         RETURNING symbol, note, enabled, created_at::text, updated_at::text`,
        [normalizeTrackingSymbol(input.symbol), input.note ?? '', input.enabled ?? true, createdAt],
      )
      if (!result.rows[0]) throw new Error('tracking_watchlist_item_exists')
      return mapWatchlistItem(result.rows[0])
    },
    async updateWatchlist(
      symbol: string,
      input: { note?: string; enabled?: boolean; updatedAt?: string },
    ): Promise<WatchlistItem | null> {
      const result = await pool.query<WatchlistItemRow>(
        `UPDATE watchlist_items SET
           note = COALESCE($2, note), enabled = COALESCE($3, enabled), updated_at = $4
         WHERE symbol = $1
         RETURNING symbol, note, enabled, created_at::text, updated_at::text`,
        [normalizeTrackingSymbol(symbol), input.note ?? null, input.enabled ?? null,
          input.updatedAt ?? new Date().toISOString()],
      )
      return result.rows[0] ? mapWatchlistItem(result.rows[0]) : null
    },
    async removeWatchlist(symbol: string): Promise<boolean> {
      const result = await pool.query(
        'DELETE FROM watchlist_items WHERE symbol = $1',
        [normalizeTrackingSymbol(symbol)],
      )
      return (result.rowCount ?? 0) > 0
    },
    async getActiveRun(): Promise<TrackingRun | null> {
      const result = await pool.query<TrackingRunRow>(
        `SELECT ${trackingRunColumns} FROM tracking_runs WHERE status = 'running'`,
      )
      return result.rows[0] ? mapTrackingRun(result.rows[0]) : null
    },
    async getRun(id: string): Promise<TrackingRunDetail | null> {
      return readTrackingRunDetail(pool, id)
    },
    async getLatestRun(): Promise<TrackingRunDetail | null> {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM tracking_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      return result.rows[0] ? readTrackingRunDetail(pool, result.rows[0].id) : null
    },
    async beginRun(input: {
      id: string; targets: TrackingTarget[]; startedAt?: string
    }): Promise<TrackingRun> {
      const startedAt = input.startedAt ?? new Date().toISOString()
      try {
        const result = await pool.query<TrackingRunRow>(
          `INSERT INTO tracking_runs (id, status, targets_json, started_at)
           VALUES ($1, 'running', $2, $3)
           RETURNING ${trackingRunColumns}`,
          [input.id, JSON.stringify(normalizeTrackingTargets(input.targets)), startedAt],
        )
        return mapTrackingRun(result.rows[0]!)
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string }
        if (databaseError.code === '23505'
          && databaseError.constraint === 'tracking_runs_one_active') {
          throw new Error('tracking_run_active')
        }
        if (databaseError.code === '23505') throw new Error('tracking_run_exists')
        throw error
      }
    },
    async latestSuccessfulObservations(symbols?: string[]): Promise<TrackingObservation[]> {
      const normalized = symbols?.map(normalizeTrackingSymbol)
      if (normalized?.length === 0) return []
      const result = await pool.query<TrackingObservationRow>(
        `SELECT DISTINCT ON (observation.symbol, observation.capability)
           observation.id, observation.run_id, observation.symbol, observation.capability,
           observation.status, observation.baseline_observation_id,
           observation.observed_at::text, observation.payload_json
         FROM tracking_observations observation
         JOIN tracking_runs run ON run.id = observation.run_id
         WHERE observation.status = 'success'
           AND run.status IN ('completed', 'partial')
           AND ($1::text[] IS NULL OR observation.symbol = ANY($1))
         ORDER BY observation.symbol, observation.capability,
           observation.observed_at DESC, run.completed_at DESC,
           run.id DESC, observation.id DESC`,
        [normalized ?? null],
      )
      return result.rows.map(mapTrackingObservation)
    },
    async completeRun(input: {
      runId: string
      status: 'completed' | 'partial' | 'failed'
      observations: TrackingObservationInput[]
      completedAt?: string
      error?: string
    }): Promise<TrackingRunDetail> {
      const completedAt = input.completedAt ?? new Date().toISOString()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const run = await client.query<Pick<TrackingRunRow, 'status' | 'targets_json'>>(
          `SELECT status, targets_json FROM tracking_runs WHERE id = $1 FOR UPDATE`,
          [input.runId],
        )
        if (!run.rows[0]) throw new Error('tracking_run_not_found')
        if (run.rows[0].status !== 'running') throw new Error('tracking_run_not_active')
        const targets = new Set(run.rows[0].targets_json.map(({ symbol }) => symbol))
        for (const observation of input.observations) {
          const symbol = normalizeTrackingSymbol(observation.symbol)
          if (!targets.has(symbol)) throw new Error('tracking_observation_outside_targets')
          const baseline = await client.query<{ id: string }>(
            `SELECT observation.id FROM tracking_observations observation
             JOIN tracking_runs run ON run.id = observation.run_id
             WHERE observation.symbol = $1 AND observation.capability = $2
               AND observation.status = 'success'
               AND run.status IN ('completed', 'partial')
             ORDER BY observation.observed_at DESC, run.completed_at DESC,
               run.id DESC, observation.id DESC LIMIT 1`,
            [symbol, observation.capability],
          )
          const baselineObservationId = baseline.rows[0]?.id ?? null
          await client.query(
            `INSERT INTO tracking_observations (
               id, run_id, symbol, capability, status, baseline_observation_id,
               observed_at, payload_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [observation.id, input.runId, symbol, observation.capability, observation.status,
              baselineObservationId, observation.observedAt, JSON.stringify(observation.payload)],
          )
          if (baselineObservationId === null) continue
          for (const event of observation.events) {
            await client.query(
              `INSERT INTO tracking_events (
                 id, run_id, observation_id, baseline_observation_id, event_key, symbol,
                 capability, kind, severity, occurred_at, payload_json, created_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (event_key) DO NOTHING`,
              [randomUUID(), input.runId, observation.id, baselineObservationId, event.eventKey,
                symbol, observation.capability, event.kind, event.severity, event.occurredAt,
                JSON.stringify(event.payload), completedAt],
            )
          }
        }
        await client.query(
          `UPDATE tracking_runs SET status = $2, completed_at = $3, error = $4
           WHERE id = $1 AND status = 'running'`,
          [input.runId, input.status, completedAt, input.error ?? null],
        )
        await client.query('COMMIT')
        const detail = await readTrackingRunDetail(pool, input.runId)
        if (!detail) throw new Error('tracking_run_not_found')
        return detail
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listEvents(options: { symbol?: string; limit?: number } = {}): Promise<TrackingEvent[]> {
      const safeLimit = Number.isInteger(options.limit)
        ? Math.max(1, Math.min(options.limit!, 500)) : 100
      const result = await pool.query<TrackingEventRow>(
        `SELECT ${trackingEventColumns} FROM tracking_events
         WHERE ($1::text IS NULL OR symbol = $1)
         ORDER BY occurred_at DESC, id DESC LIMIT $2`,
        [options.symbol ? normalizeTrackingSymbol(options.symbol) : null, safeLimit],
      )
      return result.rows.map(mapTrackingEvent)
    },
  }
}

export type TrackingRepository = ReturnType<typeof createTrackingRepository>
