import { Pool, type PoolClient } from 'pg'
import {
  defaultRuntimeSettings, parseRuntimeSettingsUpdate,
  type ExecutionSettingsSnapshot, type RuntimeSettings, type RuntimeSettingsRevision,
} from '@vibe-invest/contracts'

export const schemaVersion = 8

const migrationSql = `
CREATE TABLE IF NOT EXISTS product_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  symbol text PRIMARY KEY,
  quantity numeric NOT NULL CHECK (quantity > 0),
  average_cost numeric NOT NULL CHECK (average_cost >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  cash numeric NOT NULL CHECK (cash >= 0),
  updated_at timestamptz NOT NULL
);

INSERT INTO portfolio_settings (id, cash, updated_at)
VALUES (1, 0, now())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS portfolio_equity_snapshots (
  market_day date PRIMARY KEY,
  total_equity numeric NOT NULL,
  total_market_value numeric NOT NULL,
  cash numeric NOT NULL,
  holdings_count integer NOT NULL,
  priced_count integer NOT NULL,
  observed_at timestamptz NOT NULL,
  after_close boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS legacy_portfolio_migrations (
  source_sha256 text PRIMARY KEY,
  source_path text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  snapshot_json jsonb,
  report_json jsonb,
  error text,
  starred boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS atomic_facts (
  id text PRIMARY KEY,
  payload_json jsonb NOT NULL,
  is_public boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS analysis_facts (
  analysis_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  fact_id text NOT NULL REFERENCES atomic_facts(id),
  PRIMARY KEY (analysis_id, fact_id)
);

CREATE TABLE IF NOT EXISTS analysis_trace (
  analysis_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  payload_json jsonb NOT NULL,
  PRIMARY KEY (analysis_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id text PRIMARY KEY,
  analysis_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  execution_id text NOT NULL,
  status text NOT NULL CHECK (status <> ''),
  latest_sequence integer NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_analysis_id_key;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS execution_id text;
UPDATE agent_sessions SET execution_id = 'legacy:' || id WHERE execution_id IS NULL;
ALTER TABLE agent_sessions ALTER COLUMN execution_id SET NOT NULL;
UPDATE agent_sessions SET is_primary = true
WHERE NOT EXISTS (
  SELECT 1 FROM agent_sessions primary_session
  WHERE primary_session.analysis_id = agent_sessions.analysis_id AND primary_session.is_primary
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_one_primary_per_analysis
ON agent_sessions (analysis_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS agent_events (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  operation_id text NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS runtime_settings_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settings_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO runtime_settings_revisions (settings_json, created_at)
SELECT '${JSON.stringify(defaultRuntimeSettings)}'::jsonb, now()
WHERE NOT EXISTS (SELECT 1 FROM runtime_settings_revisions);

CREATE TABLE IF NOT EXISTS execution_settings_snapshots (
  execution_id text PRIMARY KEY,
  revision_id integer NOT NULL REFERENCES runtime_settings_revisions(id),
  settings_json jsonb NOT NULL,
  frozen_at timestamptz NOT NULL
);

WITH duplicate_active AS (
  SELECT id, row_number() OVER (PARTITION BY symbol ORDER BY created_at, id) AS position
  FROM analyses WHERE status IN ('queued', 'running')
)
UPDATE analyses SET status = 'interrupted', updated_at = now()
FROM duplicate_active
WHERE analyses.id = duplicate_active.id AND duplicate_active.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS analyses_one_active_per_symbol
ON analyses (symbol) WHERE status IN ('queued', 'running');

INSERT INTO product_schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (3)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (4)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (5)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (6)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (7)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (8)
ON CONFLICT (version) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vibe_invest_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vibe_invest_app;
GRANT SELECT ON product_schema_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON positions, portfolio_settings, portfolio_equity_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON legacy_portfolio_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analyses, atomic_facts, analysis_facts, analysis_trace TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON agent_sessions TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_events TO vibe_invest_app;
GRANT SELECT, INSERT ON runtime_settings_revisions, execution_settings_snapshots TO vibe_invest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vibe_invest_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM vibe_invest_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM vibe_invest_app;
`

export function createPool(connectionString: string) {
  return new Pool({ connectionString })
}

export async function migrate(connectionString: string) {
  const pool = createPool(connectionString)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [8_613_091])
    await client.query(migrationSql)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function checkSchema(pool: Pool) {
  const result = await pool.query<{ version: number }>(
    'SELECT max(version)::integer AS version FROM product_schema_migrations',
  )
  const version = result.rows[0]?.version ?? 0
  if (version !== schemaVersion) {
    throw new Error(`product_schema_version_mismatch:${version}:${schemaVersion}`)
  }
  return { status: 'ok' as const, version }
}

export type ProductPool = Pool

type RuntimeSettingsRevisionRow = {
  id: number
  settings_json: RuntimeSettings
  created_at: string
}

type ExecutionSettingsSnapshotRow = RuntimeSettingsRevisionRow & {
  execution_id: string
}

async function freezeExecutionSettings(
  database: Pool | PoolClient, executionId: string, frozenAt: string,
) {
  return database.query<ExecutionSettingsSnapshotRow>(
    `WITH inserted AS (
       INSERT INTO execution_settings_snapshots (execution_id, revision_id, settings_json, frozen_at)
       SELECT $1, id, settings_json, $2 FROM runtime_settings_revisions ORDER BY id DESC LIMIT 1
       ON CONFLICT (execution_id) DO NOTHING
       RETURNING execution_id, revision_id, settings_json, frozen_at
     )
     SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
     FROM inserted
     UNION ALL
     SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
     FROM execution_settings_snapshots WHERE execution_id = $1
     LIMIT 1`,
    [executionId, frozenAt],
  )
}

export function createRuntimeSettingsRepository(pool: Pool) {
  const mapRevision = (row: RuntimeSettingsRevisionRow): RuntimeSettingsRevision => ({
    id: row.id, values: row.settings_json, createdAt: row.created_at,
  })
  const mapSnapshot = (row: ExecutionSettingsSnapshotRow): ExecutionSettingsSnapshot => ({
    executionId: row.execution_id, ...mapRevision(row),
  })
  return {
    async current() {
      const result = await pool.query<RuntimeSettingsRevisionRow>(
        `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions
         ORDER BY id DESC LIMIT 1`,
      )
      if (!result.rows[0]) throw new Error('runtime_settings_revision_not_found')
      return mapRevision(result.rows[0])
    },
    async getRevision(id: number) {
      const result = await pool.query<RuntimeSettingsRevisionRow>(
        `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? mapRevision(result.rows[0]) : null
    },
    async save(update: unknown, createdAt: string) {
      const parsed = parseRuntimeSettingsUpdate(update)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [8_613_092])
        const current = await client.query<RuntimeSettingsRevisionRow>(
          `SELECT id, settings_json, created_at::text FROM runtime_settings_revisions
           ORDER BY id DESC LIMIT 1`,
        )
        if (!current.rows[0]) throw new Error('runtime_settings_revision_not_found')
        const values = { ...current.rows[0].settings_json, ...parsed }
        const result = await client.query<RuntimeSettingsRevisionRow>(
          `INSERT INTO runtime_settings_revisions (settings_json, created_at)
           VALUES ($1, $2) RETURNING id, settings_json, created_at::text`,
          [JSON.stringify(values), createdAt],
        )
        await client.query('COMMIT')
        return mapRevision(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async restoreDefaults(createdAt: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1)', [8_613_092])
        const result = await client.query<RuntimeSettingsRevisionRow>(
          `INSERT INTO runtime_settings_revisions (settings_json, created_at)
           VALUES ($1, $2) RETURNING id, settings_json, created_at::text`,
          [JSON.stringify(defaultRuntimeSettings), createdAt],
        )
        await client.query('COMMIT')
        return mapRevision(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async freezeExecution(executionId: string, frozenAt: string) {
      const result = await freezeExecutionSettings(pool, executionId, frozenAt)
      return mapSnapshot(result.rows[0]!)
    },
    async getExecutionSnapshot(executionId: string) {
      const result = await pool.query<ExecutionSettingsSnapshotRow>(
        `SELECT execution_id, revision_id AS id, settings_json, frozen_at::text AS created_at
         FROM execution_settings_snapshots WHERE execution_id = $1`,
        [executionId],
      )
      return result.rows[0] ? mapSnapshot(result.rows[0]) : null
    },
    async listActiveExecutionSnapshots() {
      const result = await pool.query<ExecutionSettingsSnapshotRow>(
        `SELECT snapshot.execution_id, snapshot.revision_id AS id, snapshot.settings_json,
                snapshot.frozen_at::text AS created_at
         FROM execution_settings_snapshots snapshot
         JOIN agent_sessions session ON session.execution_id = snapshot.execution_id
         WHERE session.status IN ('queued', 'running')
         ORDER BY snapshot.frozen_at, snapshot.execution_id`,
      )
      return result.rows.map(mapSnapshot)
    },
  }
}

export type RuntimeSettingsRepository = ReturnType<typeof createRuntimeSettingsRepository>

export type ProductPosition = {
  symbol: string
  quantity: number
  averageCost: number
}

export type ProductEquitySnapshot = {
  marketDay: string
  totalEquity: number
  totalMarketValue: number
  cash: number
  holdingsCount: number
  pricedCount: number
  observedAt: string
  afterClose: boolean
}

export type MigrationVerificationState = {
  positions: Array<{ symbol: string; quantity: string; averageCost: string }>
  cash: string
  snapshots: Array<{
    marketDay: string
    totalEquity: string
    totalMarketValue: string
    cash: string
  }>
}

export type LegacyPortfolioMigration = {
  positions: Array<{ symbol: string; quantity: string; averageCost: string; updatedAt: string }>
  cash: { value: string; updatedAt: string }
  snapshots: Array<{
    marketDay: string
    totalEquity: string
    totalMarketValue: string
    cash: string
    holdingsCount: number
    pricedCount: number
    observedAt: string
    afterClose: boolean
  }>
}

export async function executeLegacyPortfolioMigration(options: {
  connectionString: string
  sourceSha256: string
  sourcePath: string
  data: LegacyPortfolioMigration
}) {
  const pool = createPool(options.connectionString)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const receipt = await client.query(
      'SELECT source_sha256 FROM legacy_portfolio_migrations WHERE source_sha256 = $1',
      [options.sourceSha256],
    )
    if (receipt.rowCount) throw new Error('legacy_migration_already_executed')
    const target = await client.query<{ positions: number; snapshots: number; cash: string }>(
      `SELECT (SELECT count(*)::integer FROM positions) AS positions,
              (SELECT count(*)::integer FROM portfolio_equity_snapshots) AS snapshots,
              (SELECT cash::text FROM portfolio_settings WHERE id = 1 FOR UPDATE) AS cash`,
    )
    const current = target.rows[0]
    if (!current || current.positions > 0 || current.snapshots > 0 || current.cash !== '0') {
      throw new Error('legacy_migration_target_conflict')
    }
    for (const position of options.data.positions) {
      await client.query(
        `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [position.symbol, position.quantity, position.averageCost, position.updatedAt],
      )
    }
    await client.query(
      'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = 1',
      [options.data.cash.value, options.data.cash.updatedAt],
    )
    for (const snapshot of options.data.snapshots) {
      await client.query(
        `INSERT INTO portfolio_equity_snapshots (
           market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [snapshot.marketDay, snapshot.totalEquity, snapshot.totalMarketValue, snapshot.cash,
          snapshot.holdingsCount, snapshot.pricedCount, snapshot.observedAt, snapshot.afterClose],
      )
    }
    await client.query(
      `INSERT INTO legacy_portfolio_migrations (source_sha256, source_path)
       VALUES ($1, $2)`,
      [options.sourceSha256, options.sourcePath],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function verifyLegacyPortfolioMigration(
  connectionString: string,
  expected: MigrationVerificationState,
) {
  const pool = createPool(connectionString)
  try {
    const actual = await createPortfolioRepository(pool).migrationVerificationState()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('legacy_migration_verification_failed')
    }
  } finally {
    await pool.end()
  }
}

type PositionRow = { symbol: string; quantity: string; average_cost: string }
type SnapshotRow = {
  market_day: string
  total_equity: string
  total_market_value: string
  cash: string
  holdings_count: number
  priced_count: number
  observed_at: string
  after_close: boolean
}

export function createPortfolioRepository(pool: Pool) {
  return {
    async list(): Promise<ProductPosition[]> {
      const result = await pool.query<PositionRow>(
        `SELECT symbol, quantity::text, average_cost::text
         FROM positions ORDER BY symbol`,
      )
      return result.rows.map(toPosition)
    },
    async save(position: ProductPosition) {
      await pool.query(
        `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (symbol) DO UPDATE SET
           quantity = excluded.quantity,
           average_cost = excluded.average_cost,
           updated_at = excluded.updated_at`,
        [position.symbol, String(position.quantity), String(position.averageCost), new Date().toISOString()],
      )
      return position
    },
    async remove(symbol: string) {
      await pool.query('DELETE FROM positions WHERE symbol = $1', [symbol])
    },
    async cash() {
      const result = await pool.query<{ cash: string }>(
        'SELECT cash::text FROM portfolio_settings WHERE id = $1',
        [1],
      )
      return Number(result.rows[0]?.cash ?? 0)
    },
    async setCash(cash: number) {
      await pool.query(
        'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = $3',
        [String(cash), new Date().toISOString(), 1],
      )
      return cash
    },
    async reduce(symbol: string, quantity: number, price: number) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const positionResult = await client.query<PositionRow>(
          `SELECT symbol, quantity::text, average_cost::text
           FROM positions WHERE symbol = $1 FOR UPDATE`,
          [symbol],
        )
        const row = positionResult.rows[0]
        if (!row || quantity > Number(row.quantity)) {
          await client.query('ROLLBACK')
          return null
        }
        const cashResult = await client.query<{ cash: string }>(
          'SELECT cash::text FROM portfolio_settings WHERE id = $1 FOR UPDATE',
          [1],
        )
        const remaining = Number(row.quantity) - quantity
        const proceeds = quantity * price
        const cash = Number(cashResult.rows[0]?.cash ?? 0) + proceeds
        if (remaining === 0) {
          await client.query('DELETE FROM positions WHERE symbol = $1', [symbol])
        } else {
          await client.query(
            'UPDATE positions SET quantity = $1, updated_at = $2 WHERE symbol = $3',
            [String(remaining), new Date().toISOString(), symbol],
          )
        }
        await client.query(
          'UPDATE portfolio_settings SET cash = $1, updated_at = $2 WHERE id = $3',
          [String(cash), new Date().toISOString(), 1],
        )
        await client.query('COMMIT')
        return {
          position: remaining === 0 ? null : toPosition({ ...row, quantity: String(remaining) }),
          cash,
          proceeds,
          realizedProfitLoss: (price - Number(row.average_cost)) * quantity,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async saveSnapshot(snapshot: ProductEquitySnapshot) {
      const result = await pool.query(
        `INSERT INTO portfolio_equity_snapshots (
           market_day, total_equity, total_market_value, cash,
           holdings_count, priced_count, observed_at, after_close
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (market_day) DO UPDATE SET
           total_equity = excluded.total_equity,
           total_market_value = excluded.total_market_value,
           cash = excluded.cash,
           holdings_count = excluded.holdings_count,
           priced_count = excluded.priced_count,
           observed_at = excluded.observed_at,
           after_close = excluded.after_close
         WHERE portfolio_equity_snapshots.after_close = false OR excluded.after_close = true`,
        [snapshot.marketDay, String(snapshot.totalEquity), String(snapshot.totalMarketValue),
          String(snapshot.cash), snapshot.holdingsCount, snapshot.pricedCount,
          snapshot.observedAt, snapshot.afterClose],
      )
      return (result.rowCount ?? 0) > 0
    },
    async listSnapshots(limit: number): Promise<ProductEquitySnapshot[]> {
      const result = await pool.query<SnapshotRow>(
        `SELECT market_day::text, total_equity::text, total_market_value::text,
                cash::text, holdings_count, priced_count,
                observed_at::text, after_close
         FROM portfolio_equity_snapshots
         ORDER BY market_day DESC LIMIT $1`,
        [limit],
      )
      return result.rows.map((row) => ({
        marketDay: row.market_day,
        totalEquity: Number(row.total_equity),
        totalMarketValue: Number(row.total_market_value),
        cash: Number(row.cash),
        holdingsCount: row.holdings_count,
        pricedCount: row.priced_count,
        observedAt: new Date(row.observed_at).toISOString(),
        afterClose: row.after_close,
      }))
    },
    async migrationVerificationState(): Promise<MigrationVerificationState> {
      const [positions, cash, snapshots] = await Promise.all([
        pool.query<{ symbol: string; quantity: string; average_cost: string }>(
          'SELECT symbol, quantity::text, average_cost::text FROM positions ORDER BY symbol',
        ),
        pool.query<{ cash: string }>('SELECT cash::text FROM portfolio_settings WHERE id = $1', [1]),
        pool.query<{
          market_day: string; total_equity: string; total_market_value: string; cash: string
        }>(
          `SELECT market_day::text, total_equity::text, total_market_value::text, cash::text
           FROM portfolio_equity_snapshots ORDER BY market_day`,
        ),
      ])
      return {
        positions: positions.rows.map((row) => ({
          symbol: row.symbol, quantity: row.quantity, averageCost: row.average_cost,
        })),
        cash: cash.rows[0]?.cash ?? '0',
        snapshots: snapshots.rows.map((row) => ({
          marketDay: row.market_day, totalEquity: row.total_equity,
          totalMarketValue: row.total_market_value, cash: row.cash,
        })),
      }
    },
  }
}

export type PortfolioRepository = ReturnType<typeof createPortfolioRepository>

export type AnalysisRecord = {
  id: string
  symbol: string
  status: string
  createdAt: string
  updatedAt: string
  snapshot: unknown
  report: unknown
  error: string | null
  starred: boolean
  note: string
}

type AnalysisRow = {
  id: string; symbol: string; status: string; created_at: string; updated_at: string
  snapshot_json: unknown; report_json: unknown; error: string | null; starred: boolean; note: string
}

export function createAnalysisRepository(pool: Pool) {
  const terminal = ['completed', 'partial', 'failed', 'cancelled', 'interrupted']
  return {
    async interruptRunning(updatedAt: string) {
      await pool.query(
        `UPDATE analyses SET status = 'interrupted', updated_at = $1
         WHERE status IN ('queued', 'running')`, [updatedAt],
      )
    },
    async saveFact(analysisId: string, fact: { id: string } & Record<string, unknown>) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO atomic_facts (id, payload_json, is_public) VALUES ($1, $2, true)
           ON CONFLICT (id) DO NOTHING`, [fact.id, JSON.stringify(fact)],
        )
        await client.query(
          `INSERT INTO analysis_facts (analysis_id, fact_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`, [analysisId, fact.id],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
    async appendTrace(analysisId: string, payload: unknown) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const parent = await client.query('SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [analysisId])
        if (!parent.rowCount) throw new Error('analysis_not_found')
        await client.query(
          `INSERT INTO analysis_trace (analysis_id, sequence, payload_json)
           SELECT $1, COALESCE(max(sequence), 0) + 1, $2
           FROM analysis_trace WHERE analysis_id = $1`,
          [analysisId, JSON.stringify(payload)],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async setStatus(id: string, status: string, updatedAt: string, extra: {
      report?: unknown; snapshot?: unknown; error?: string
    } = {}) {
      await pool.query(
        `UPDATE analyses SET status = $1, updated_at = $2,
           report_json = COALESCE($3::jsonb, report_json),
           snapshot_json = COALESCE($4::jsonb, snapshot_json),
           error = COALESCE($5, error) WHERE id = $6`,
        [status, updatedAt, extra.report ? JSON.stringify(extra.report) : null,
          extra.snapshot ? JSON.stringify(extra.snapshot) : null, extra.error ?? null, id],
      )
    },
    async get(id: string) {
      const result = await pool.query<AnalysisRow>('SELECT * FROM analyses WHERE id = $1', [id])
      return result.rows[0] ? mapAnalysisRow(result.rows[0]) : null
    },
    async createOrReturn(record: { id: string; symbol: string; status: string; createdAt: string; updatedAt: string }) {
      const result = await pool.query<{ id: string; created: boolean }>(
        `INSERT INTO analyses (id, symbol, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (symbol) WHERE status IN ('queued', 'running')
         DO UPDATE SET symbol = excluded.symbol
         RETURNING id, id = $1 AS created`,
        [record.id, record.symbol, record.status, record.createdAt, record.updatedAt],
      )
      return { analysisId: result.rows[0]!.id, created: result.rows[0]!.created }
    },
    async claimNextQueued(updatedAt: string) {
      const result = await pool.query<{ id: string }>(
        `WITH candidate AS (
           SELECT id FROM analyses
           WHERE status = 'queued'
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE analyses SET status = 'running', updated_at = $1
         FROM candidate
         WHERE analyses.id = candidate.id
         RETURNING analyses.id`, [updatedAt],
      )
      return result.rows[0]?.id ?? null
    },
    async saveSnapshot(id: string, snapshot: unknown) {
      await pool.query('UPDATE analyses SET snapshot_json = $1 WHERE id = $2', [JSON.stringify(snapshot), id])
    },
    async research(id: string) {
      const analysis = await this.get(id)
      if (!analysis) return null
      const [facts, trace] = await Promise.all([
        pool.query<{ payload_json: unknown }>(
          `SELECT f.payload_json FROM atomic_facts f
           JOIN analysis_facts af ON af.fact_id = f.id WHERE af.analysis_id = $1`, [id],
        ),
        pool.query<{ payload_json: unknown }>(
          'SELECT payload_json FROM analysis_trace WHERE analysis_id = $1 ORDER BY sequence', [id],
        ),
      ])
      return { ...analysis, facts: facts.rows.map((row) => row.payload_json), trace: trace.rows.map((row) => row.payload_json) }
    },
    async listResearch(symbol?: string) {
      const params: unknown[] = [terminal]
      const condition = symbol ? 'symbol = $2 AND status = ANY($1)' : 'status = ANY($1)'
      if (symbol) params.push(symbol.toUpperCase())
      const result = await pool.query<AnalysisRow>(
        `SELECT * FROM analyses WHERE ${condition} ORDER BY created_at DESC`, params,
      )
      return result.rows.map(mapAnalysisRow)
    },
    async updateResearch(id: string, values: { starred?: boolean; note?: string }, updatedAt: string) {
      const result = await pool.query<AnalysisRow>(
        `UPDATE analyses SET starred = COALESCE($1, starred), note = COALESCE($2, note), updated_at = $3
         WHERE id = $4 RETURNING *`, [values.starred ?? null, values.note ?? null, updatedAt, id],
      )
      return result.rows[0] ? mapAnalysisRow(result.rows[0]) : null
    },
    async removeResearch(id: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const removed = await client.query('DELETE FROM analyses WHERE id = $1', [id])
        if (!removed.rowCount) { await client.query('ROLLBACK'); return false }
        await client.query('DELETE FROM atomic_facts WHERE id NOT IN (SELECT fact_id FROM analysis_facts)')
        await client.query('COMMIT')
        return true
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
  }
}

export type AnalysisRepository = ReturnType<typeof createAnalysisRepository>

export type AgentEvent = {
  sessionId: string
  sequence: number
  operationId: string
  payload: Record<string, unknown>
  createdAt: string
}

export type AgentSession = {
  id: string
  analysisId: string
  status: string
  isPrimary: boolean
  executionId: string
  latestSequence: number
  createdAt: string
  updatedAt: string
}

type AgentEventRow = {
  session_id: string
  sequence: number
  operation_id: string
  payload_json: Record<string, unknown>
  created_at: string
}

type AgentSessionRow = {
  id: string
  analysis_id: string
  status: string
  is_primary: boolean
  execution_id: string
  latest_sequence: number
  created_at: string
  updated_at: string
}

export function createAgentEventRepository(pool: Pool) {
  return {
    async createResearch(input: {
      analysisId: string
      sessionId: string
      executionId: string
      symbol: string
      status: string
      operationId: string
      event: Record<string, unknown>
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ id: string; created: boolean }>(
          `INSERT INTO analyses (id, symbol, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (symbol) WHERE status IN ('queued', 'running')
           DO UPDATE SET symbol = excluded.symbol
           RETURNING id, id = $1 AS created`,
          [input.analysisId, input.symbol, input.status, input.createdAt],
        )
        const analysisId = analysis.rows[0]!.id
        if (!analysis.rows[0]!.created) {
          await client.query('COMMIT')
          const existing = await this.findPrimarySession(analysisId)
          if (!existing) throw new Error('agent_session_not_found')
          const event = (await this.list(existing.id, 0))[0]!
          return { analysisId, sessionId: existing.id, sequence: event.sequence, created: false, event }
        }
        await client.query(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, true, $3, $4, 1, $5, $5)`,
          [input.sessionId, analysisId, input.executionId, input.status, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, 1, $2, $3, $4)`,
          [input.sessionId, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { analysisId, sessionId: input.sessionId, sequence: 1, created: true, event: {
          sessionId: input.sessionId, sequence: 1, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async createSession(input: {
      id: string
      analysisId: string
      executionId: string
      status: string
      operationId: string
      event: Record<string, unknown>
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query('SELECT id FROM analyses WHERE id = $1 FOR KEY SHARE', [input.analysisId])
        if (!analysis.rowCount) throw new Error('analysis_not_found')
        await client.query(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, false, $3, $4, 1, $5, $5)`,
          [input.id, input.analysisId, input.executionId, input.status, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, 1, $2, $3, $4)`,
          [input.id, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { sequence: 1, created: true, event: {
          sessionId: input.id, sequence: 1, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async append(input: {
      sessionId: string
      operationId: string
      event: Record<string, unknown>
      projection?: {
        status?: string
        report?: unknown
        snapshot?: unknown
        error?: string
        facts?: Array<{ id: string } & Record<string, unknown>>
      }
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const session = await client.query<{
          latest_sequence: number; analysis_id: string; is_primary: boolean
        }>(
          'SELECT latest_sequence, analysis_id, is_primary FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const existing = await client.query<{ sequence: number }>(
          `SELECT sequence FROM agent_events
           WHERE session_id = $1 AND operation_id = $2`,
          [input.sessionId, input.operationId],
        )
        if (existing.rows[0]) {
          const event = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [input.sessionId, input.operationId],
          )
          await client.query('COMMIT')
          return { sequence: existing.rows[0].sequence, created: false, event: mapAgentEventRow(event.rows[0]!) }
        }
        const sequence = session.rows[0].latest_sequence + 1
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        for (const fact of input.projection?.facts ?? []) {
          await client.query(
            `INSERT INTO atomic_facts (id, payload_json, is_public) VALUES ($1, $2, true)
             ON CONFLICT (id) DO NOTHING`,
            [fact.id, JSON.stringify(fact)],
          )
          await client.query(
            `INSERT INTO analysis_facts (analysis_id, fact_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [session.rows[0].analysis_id, fact.id],
          )
        }
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1,
             status = COALESCE($2, status), updated_at = $3 WHERE id = $4`,
          [sequence, input.projection?.status ?? null, input.createdAt, input.sessionId],
        )
        if (input.projection && session.rows[0].is_primary) {
          await client.query(
            `UPDATE analyses SET status = COALESCE($1, status), updated_at = $2,
               report_json = COALESCE($3::jsonb, report_json),
               snapshot_json = COALESCE($4::jsonb, snapshot_json),
               error = COALESCE($5, error) WHERE id = $6`,
            [input.projection.status, input.createdAt,
              input.projection.report ? JSON.stringify(input.projection.report) : null,
              input.projection.snapshot ? JSON.stringify(input.projection.snapshot) : null,
              input.projection.error ?? null, session.rows[0].analysis_id],
          )
        }
        await client.query('COMMIT')
        return { sequence, created: true, event: {
          sessionId: input.sessionId, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async interruptActiveSessions(createdAt: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessions = await client.query<{
          id: string; analysis_id: string; is_primary: boolean; latest_sequence: number
        }>(
          `SELECT id, analysis_id, is_primary, latest_sequence FROM agent_sessions
           WHERE status IN ('queued', 'running') ORDER BY id FOR UPDATE`,
        )
        const interrupted: AgentEvent[] = []
        for (const session of sessions.rows) {
          const sequence = session.latest_sequence + 1
          const operationId = `startup:interrupt:${session.id}:${sequence}`
          const payload = { type: 'status', status: 'interrupted', at: createdAt }
          await client.query(
            `INSERT INTO agent_events (
               session_id, sequence, operation_id, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [session.id, sequence, operationId, JSON.stringify(payload), createdAt],
          )
          await client.query(
            `UPDATE agent_sessions SET status = 'interrupted', latest_sequence = $1, updated_at = $2
             WHERE id = $3`,
            [sequence, createdAt, session.id],
          )
          if (session.is_primary) {
            await client.query(
              `UPDATE analyses SET status = 'interrupted', updated_at = $1 WHERE id = $2`,
              [createdAt, session.analysis_id],
            )
          }
          interrupted.push({
            sessionId: session.id, sequence, operationId, payload, createdAt,
          })
        }
        await client.query('COMMIT')
        return interrupted
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async list(sessionId: string, afterSequence: number): Promise<AgentEvent[]> {
      const result = await pool.query<AgentEventRow>(
        `SELECT session_id, sequence, operation_id, payload_json, created_at::text
         FROM agent_events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence`,
        [sessionId, afterSequence],
      )
      return result.rows.map(mapAgentEventRow)
    },
    async getSession(id: string): Promise<AgentSession | null> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : null
    },
    async findPrimarySession(analysisId: string): Promise<AgentSession | null> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE analysis_id = $1 AND is_primary`,
        [analysisId],
      )
      return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : null
    },
    async listSessions(analysisId: string): Promise<AgentSession[]> {
      const result = await pool.query<AgentSessionRow>(
        `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at::text, updated_at::text
         FROM agent_sessions WHERE analysis_id = $1 ORDER BY is_primary DESC, created_at, id`,
        [analysisId],
      )
      return result.rows.map(mapAgentSessionRow)
    },
  }
}

export type AgentEventRepository = ReturnType<typeof createAgentEventRepository>

function mapAgentEventRow(row: AgentEventRow): AgentEvent {
  return {
    sessionId: row.session_id,
    sequence: row.sequence,
    operationId: row.operation_id,
    payload: row.payload_json,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    status: row.status,
    isPrimary: row.is_primary,
    executionId: row.execution_id,
    latestSequence: row.latest_sequence,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function mapAnalysisRow(row: AnalysisRow): AnalysisRecord {
  return {
    id: row.id, symbol: row.symbol, status: row.status,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    snapshot: row.snapshot_json, report: row.report_json, error: row.error,
    starred: row.starred, note: row.note,
  }
}

function toPosition(row: PositionRow): ProductPosition {
  return {
    symbol: row.symbol,
    quantity: Number(row.quantity),
    averageCost: Number(row.average_cost),
  }
}
