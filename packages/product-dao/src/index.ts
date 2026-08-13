import { Pool, type PoolClient } from 'pg'
import {
  agentExecutionStatuses, defaultRuntimeSettings, parseRuntimeSettingsUpdate,
  terminalAgentExecutionStatuses,
  type AgentExecutionStatus,
  type ExecutionSettingsSnapshot, type RuntimeSettings, type RuntimeSettingsRevision,
} from '@vibe-invest/contracts'

export const schemaVersion = 13

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
  report_created_at timestamptz,
  error text,
  starred boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT ''
);

ALTER TABLE analyses ADD COLUMN IF NOT EXISTS report_created_at timestamptz;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;

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

CREATE TABLE IF NOT EXISTS agent_executions (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN (
    'planning', 'running_model', 'running_tools', 'waiting_for_specialists', 'finalizing',
    'completed', 'partial', 'failed', 'stopping', 'stopped', 'interrupted', 'budget_exhausted'
  )),
  wait_reason_json jsonb,
  terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (session_id, generation)
);

ALTER TABLE agent_executions ADD COLUMN IF NOT EXISTS terminal boolean NOT NULL DEFAULT false;
UPDATE agent_executions SET terminal = status IN (
  'completed', 'partial', 'failed', 'stopped', 'interrupted', 'budget_exhausted'
) WHERE terminal = false;

CREATE TABLE IF NOT EXISTS conversation_segments (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, ordinal)
);

INSERT INTO agent_executions (
  id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
)
SELECT session.execution_id, session.id, 1,
  CASE session.status
    WHEN 'queued' THEN 'planning'
    WHEN 'running' THEN 'running_model'
    WHEN 'cancelled' THEN 'stopped'
    WHEN 'completed' THEN 'completed'
    WHEN 'partial' THEN 'partial'
    WHEN 'failed' THEN 'failed'
    WHEN 'interrupted' THEN 'interrupted'
    ELSE 'interrupted'
  END,
  CASE session.status
    WHEN 'queued' THEN jsonb_build_object('kind', 'database', 'target', '研究规划', 'startedAt', session.updated_at)
    WHEN 'running' THEN jsonb_build_object('kind', 'model', 'target', '主模型响应', 'startedAt', session.updated_at)
    ELSE NULL
  END,
  session.status NOT IN ('queued', 'running'),
  session.created_at, session.updated_at
FROM agent_sessions session
ON CONFLICT (id) DO NOTHING;

UPDATE agent_executions execution
SET terminal = COALESCE(
  (
    SELECT (event.payload_json->>'terminal')::boolean
    FROM agent_events event
    WHERE event.session_id = execution.session_id
      AND event.payload_json->>'status' = 'budget_exhausted'
      AND event.payload_json ? 'terminal'
    ORDER BY event.sequence DESC LIMIT 1
  ), true
)
WHERE execution.status = 'budget_exhausted';

UPDATE agent_sessions SET status = 'stopped' WHERE status = 'cancelled';
UPDATE analyses SET status = 'stopped' WHERE status = 'cancelled';

DROP INDEX IF EXISTS agent_executions_one_active_per_session;
CREATE UNIQUE INDEX agent_executions_one_active_per_session
ON agent_executions (session_id) WHERE terminal = false;

INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
SELECT session.id || ':segment:1', session.id, 1, session.created_at
FROM agent_sessions session
ON CONFLICT (session_id, ordinal) DO NOTHING;

UPDATE analyses analysis
SET report_created_at = COALESCE(
  (
    SELECT max(event.created_at)
    FROM agent_sessions session
    JOIN agent_events event ON event.session_id = session.id
    WHERE session.analysis_id = analysis.id
      AND session.is_primary
      AND event.payload_json->>'type' = 'status'
      AND event.payload_json->>'status' IN ('completed', 'partial')
  ),
  analysis.updated_at
)
WHERE analysis.report_json IS NOT NULL
  AND analysis.report_created_at IS NULL;

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

CREATE TABLE IF NOT EXISTS tool_projection_versions (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  role text NOT NULL CHECK (role <> ''),
  stage text NOT NULL CHECK (stage <> ''),
  schema_hash text NOT NULL CHECK (schema_hash <> ''),
  projected_tools_json jsonb NOT NULL CHECK (jsonb_typeof(projected_tools_json) = 'array'),
  visible_tool_names_json jsonb NOT NULL CHECK (jsonb_typeof(visible_tool_names_json) = 'array'),
  reasons_json jsonb NOT NULL CHECK (jsonb_typeof(reasons_json) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (execution_id, version),
  UNIQUE (execution_id, role, stage, schema_hash, visible_tool_names_json)
);

CREATE TABLE IF NOT EXISTS model_requests (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  projection_id text NOT NULL REFERENCES tool_projection_versions(id),
  turn_index integer NOT NULL CHECK (turn_index > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_call_batches (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  projection_id text NOT NULL REFERENCES tool_projection_versions(id),
  turn_index integer NOT NULL CHECK (turn_index > 0),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS tool_batch_calls (
  batch_id text NOT NULL REFERENCES tool_call_batches(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL CHECK (tool_name <> ''),
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  completed_at timestamptz,
  PRIMARY KEY (batch_id, tool_call_id),
  UNIQUE (batch_id, position)
);

UPDATE analyses analysis SET active = EXISTS (
  SELECT 1 FROM agent_sessions session
  JOIN agent_executions execution ON execution.session_id = session.id
  WHERE session.analysis_id = analysis.id AND session.is_primary AND execution.terminal = false
);
WITH duplicate_active AS (
  SELECT id, row_number() OVER (PARTITION BY symbol ORDER BY created_at, id) AS position
  FROM analyses WHERE active
)
UPDATE analyses SET status = 'interrupted', active = false, updated_at = now()
FROM duplicate_active
WHERE analyses.id = duplicate_active.id AND duplicate_active.position > 1;

DROP INDEX IF EXISTS analyses_one_active_per_symbol;
CREATE UNIQUE INDEX analyses_one_active_per_symbol ON analyses (symbol) WHERE active;

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

INSERT INTO product_schema_migrations (version)
VALUES (9)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (10)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (11)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (12)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (13)
ON CONFLICT (version) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vibe_invest_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vibe_invest_app;
GRANT SELECT ON product_schema_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON positions, portfolio_settings, portfolio_equity_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON legacy_portfolio_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analyses, atomic_facts, analysis_facts, analysis_trace TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON agent_sessions TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_events TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON agent_executions TO vibe_invest_app;
GRANT SELECT, INSERT ON conversation_segments TO vibe_invest_app;
GRANT SELECT, INSERT ON runtime_settings_revisions, execution_settings_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON tool_projection_versions, model_requests, tool_call_batches, tool_batch_calls TO vibe_invest_app;
GRANT UPDATE ON tool_call_batches, tool_batch_calls TO vibe_invest_app;
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
         JOIN agent_executions execution ON execution.id = snapshot.execution_id
         WHERE execution.terminal = false
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
  reportCreatedAt: string | null
  error: string | null
  starred: boolean
  note: string
  terminal?: boolean
}

type AnalysisRow = {
  id: string; symbol: string; status: string; created_at: string; updated_at: string
  snapshot_json: unknown; report_json: unknown; report_created_at: string | null
  error: string | null; starred: boolean; note: string
  terminal?: boolean | null
}

export function createAnalysisRepository(pool: Pool) {
  const terminal = terminalAgentExecutionStatuses
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
           report_created_at = CASE WHEN $3::jsonb IS NULL THEN report_created_at ELSE $2 END,
           snapshot_json = COALESCE($4::jsonb, snapshot_json),
           error = COALESCE($5, error) WHERE id = $6`,
        [status, updatedAt, extra.report ? JSON.stringify(extra.report) : null,
          extra.snapshot ? JSON.stringify(extra.snapshot) : null, extra.error ?? null, id],
      )
    },
    async get(id: string) {
      const result = await pool.query<AnalysisRow>(
        `SELECT analysis.*,
           CASE WHEN event.payload_json->>'terminal' IS NULL THEN NULL
             ELSE (event.payload_json->>'terminal')::boolean END AS terminal
         FROM analyses analysis
         LEFT JOIN agent_sessions session
           ON session.analysis_id = analysis.id AND session.is_primary
         LEFT JOIN agent_events event
           ON event.session_id = session.id AND event.sequence = session.latest_sequence
         WHERE analysis.id = $1`, [id],
      )
      return result.rows[0] ? mapAnalysisRow(result.rows[0]) : null
    },
    async createOrReturn(record: { id: string; symbol: string; status: string; createdAt: string; updatedAt: string }) {
      const active = ['queued', 'running'].includes(record.status)
      const result = await pool.query<{ id: string; created: boolean }>(
        `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (symbol) WHERE active
         DO UPDATE SET symbol = excluded.symbol
         RETURNING id, id = $1 AS created`,
        [record.id, record.symbol, record.status, active, record.createdAt, record.updatedAt],
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
    async fenceForStopping(input: {
      sessionId: string; executionId: string; fenceExecutionId: string
      operationId: string; event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const session = await client.query<{
          latest_sequence: number; analysis_id: string; is_primary: boolean; execution_id: string
        }>(
          `SELECT latest_sequence, analysis_id, is_primary, execution_id
           FROM agent_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].execution_id !== input.executionId) throw new Error('agent_execution_fenced')
        const execution = await client.query<{ generation: number; terminal: boolean }>(
          'SELECT generation, terminal FROM agent_executions WHERE id = $1 FOR UPDATE',
          [input.executionId],
        )
        if (!execution.rows[0]) throw new Error('agent_execution_not_found')
        if (execution.rows[0].terminal) throw new Error('agent_execution_terminal')
        const sequence = session.rows[0].latest_sequence + 1
        const waitReason = input.event.waitReason ?? null
        await client.query(
          'UPDATE agent_executions SET terminal = true, updated_at = $1 WHERE id = $2',
          [input.createdAt, input.executionId],
        )
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'stopping', $4, false, $5, $5)`,
          [input.fenceExecutionId, input.sessionId, execution.rows[0].generation + 1,
            waitReason ? JSON.stringify(waitReason) : null, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'stopping', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.fenceExecutionId, sequence, input.createdAt, input.sessionId],
        )
        if (session.rows[0].is_primary) await client.query(
          `UPDATE analyses SET status = 'stopping', active = true, updated_at = $1 WHERE id = $2`,
          [input.createdAt, session.rows[0].analysis_id],
        )
        await client.query('COMMIT')
        return { sessionId: input.sessionId, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async createResearch(input: {
      analysisId: string
      sessionId: string
      executionId: string
      segmentId?: string
      symbol: string
      status: string
      analysisStatus?: string
      operationId: string
      event: Record<string, unknown>
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ id: string; created: boolean }>(
          `INSERT INTO analyses (id, symbol, status, active, created_at, updated_at)
           VALUES ($1, $2, $3, true, $4, $4)
           ON CONFLICT (symbol) WHERE active
           DO UPDATE SET symbol = excluded.symbol
           RETURNING id, id = $1 AS created`,
          [input.analysisId, input.symbol, input.analysisStatus ?? input.status, input.createdAt],
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
        const segmentId = input.segmentId ?? `${input.sessionId}:segment:1`
        const waitReason = {
          kind: 'database', target: '首次研究初始化', startedAt: input.createdAt,
        }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, 'planning', $3, false, $4, $4)`,
          [input.executionId, input.sessionId, JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`,
          [segmentId, input.sessionId, input.createdAt],
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
      segmentId?: string
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
        const executionStatus = input.status === 'queued' ? 'planning'
          : input.status === 'running' ? 'running_model'
            : isAgentExecutionStatus(input.status) ? input.status : 'interrupted'
        const waitReason = executionStatus === 'planning'
          ? { kind: 'database', target: '研究规划', startedAt: input.createdAt }
          : executionStatus === 'running_model'
            ? { kind: 'model', target: '模型响应', startedAt: input.createdAt }
            : null
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, $6)`,
          [input.executionId, input.id, executionStatus,
            waitReason ? JSON.stringify(waitReason) : null,
            terminalAgentExecutionStatuses.includes(
              executionStatus as typeof terminalAgentExecutionStatuses[number],
            ),
            input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`,
          [input.segmentId ?? `${input.id}:segment:1`, input.id, input.createdAt],
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
      executionId: string
      operationId: string
      event: Record<string, unknown>
      projection?: {
        status?: string
        executionStatus?: AgentExecutionStatus
        waitTarget?: string
        terminal?: boolean
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
          latest_sequence: number; analysis_id: string; is_primary: boolean; execution_id: string
        }>(
          'SELECT latest_sequence, analysis_id, is_primary, execution_id FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].execution_id !== input.executionId) throw new Error('agent_execution_fenced')
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
        const execution = await client.query<{ id: string; status: string; terminal: boolean }>(
          `SELECT id, status, terminal FROM agent_executions WHERE id = $1 FOR UPDATE`,
          [input.executionId],
        )
        if (!execution.rows[0]) throw new Error('agent_execution_not_found')
        const current = execution.rows[0]
        if (current.terminal) throw new Error('agent_execution_terminal')
        if (current.status === 'stopping' && input.projection?.executionStatus !== 'stopped') {
          throw new Error('agent_execution_stopping')
        }
        const sequence = session.rows[0].latest_sequence + 1
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        if (input.projection?.executionStatus) {
          const waitReason = input.event.waitReason ?? null
          const terminal = input.projection.terminal
            ?? input.event.terminal === true
          await client.query(
            `UPDATE agent_executions SET status = $1, wait_reason_json = $2,
               terminal = $3, updated_at = $4 WHERE id = $5`,
            [input.projection.executionStatus, waitReason ? JSON.stringify(waitReason) : null,
              terminal, input.createdAt, current.id],
          )
          if (terminal) {
            await client.query(
              `UPDATE tool_batch_calls call SET status = 'cancelled', completed_at = $1
               FROM tool_call_batches batch
               WHERE call.batch_id = batch.id AND batch.execution_id = $2
                 AND batch.status = 'running' AND call.status = 'running'`,
              [input.createdAt, current.id],
            )
            await client.query(
              `UPDATE tool_call_batches SET status = 'cancelled', completed_at = $1
               WHERE execution_id = $2 AND status = 'running'`,
              [input.createdAt, current.id],
            )
          }
        }
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
          `UPDATE analyses SET status = COALESCE($1, status),
               active = CASE WHEN $6::boolean IS NULL THEN active ELSE NOT $6 END,
               updated_at = $2,
               report_json = COALESCE($3::jsonb, report_json),
               report_created_at = CASE WHEN $3::jsonb IS NULL THEN report_created_at ELSE $2 END,
               snapshot_json = COALESCE($4::jsonb, snapshot_json),
               error = COALESCE($5, error) WHERE id = $7`,
            [input.projection.status, input.createdAt,
              input.projection.report ? JSON.stringify(input.projection.report) : null,
              input.projection.snapshot ? JSON.stringify(input.projection.snapshot) : null,
              input.projection.error ?? null, input.projection.terminal ?? null,
              session.rows[0].analysis_id],
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
          `SELECT session.id, session.analysis_id, session.is_primary, session.latest_sequence
           FROM agent_sessions session
           JOIN agent_executions execution ON execution.session_id = session.id
           WHERE execution.terminal = false
           ORDER BY session.id FOR UPDATE OF session, execution`,
        )
        const interrupted: AgentEvent[] = []
        for (const session of sessions.rows) {
          const sequence = session.latest_sequence + 1
          const operationId = `startup:interrupt:${session.id}:${sequence}`
          const payload = { type: 'status', status: 'interrupted', terminal: true, at: createdAt }
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
          await client.query(
            `UPDATE agent_executions
             SET status = 'interrupted', wait_reason_json = NULL, terminal = true, updated_at = $1
             WHERE session_id = $2 AND terminal = false`,
            [createdAt, session.id],
          )
          if (session.is_primary) {
            await client.query(
              `UPDATE analyses SET status = 'interrupted', active = false, updated_at = $1 WHERE id = $2`,
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
    async primaryLifecycle(analysisId: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const sessionResult = await client.query<AgentSessionRow>(
          `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence,
             created_at::text, updated_at::text
           FROM agent_sessions WHERE analysis_id = $1 AND is_primary`,
          [analysisId],
        )
        const sessionRow = sessionResult.rows[0]
        if (!sessionRow) { await client.query('COMMIT'); return null }
        const session = mapAgentSessionRow(sessionRow)
        const execution = await client.query<{
          id: string; generation: number; status: string; terminal: boolean
          wait_reason_json: Record<string, unknown> | null
          created_at: string; updated_at: string
        }>(
          `SELECT id, generation, status, terminal, wait_reason_json, created_at::text, updated_at::text
           FROM agent_executions WHERE session_id = $1 ORDER BY generation DESC LIMIT 1`,
          [session.id],
        )
        const segments = await client.query<{ id: string; ordinal: number; created_at: string }>(
          `SELECT id, ordinal, created_at::text FROM conversation_segments
           WHERE session_id = $1 ORDER BY ordinal`, [session.id],
        )
        const eventRows = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 ORDER BY sequence`, [session.id],
        )
        const current = execution.rows[0]
        if (!current) { await client.query('COMMIT'); return null }
        const lifecycle = {
          ...session, status: current.status, waitReason: current.wait_reason_json,
          execution: {
            id: current.id, generation: current.generation, status: current.status,
            terminal: current.terminal,
            createdAt: new Date(current.created_at).toISOString(),
            updatedAt: new Date(current.updated_at).toISOString(),
          },
          segments: segments.rows.map((segment) => ({
            id: segment.id, ordinal: segment.ordinal,
            createdAt: new Date(segment.created_at).toISOString(),
          })),
          events: eventRows.rows.map(mapAgentEventRow).map((event) => ({
            sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
          })),
        }
        await client.query('COMMIT')
        return lifecycle
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export type AgentEventRepository = ReturnType<typeof createAgentEventRepository>

type ToolProjectionRow = {
  id: string; execution_id: string; version: number; role: string; stage: string
  schema_hash: string; projected_tools_json: unknown[]
  visible_tool_names_json: string[]; reasons_json: Record<string, unknown>
  created_at: string
}

export function createToolProjectionRepository(pool: Pool) {
  return {
    async ensureVersion(input: {
      executionId: string; role: string; stage: string; schemaHash: string
      projectedTools: unknown[]; visibleToolNames: string[]
      reasons: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        const running = await client.query(
          `SELECT batch.id FROM tool_call_batches batch
           JOIN tool_projection_versions projection ON projection.id = batch.projection_id
           WHERE batch.execution_id = $1 AND projection.role = $2 AND batch.status = 'running' LIMIT 1`,
          [input.executionId, input.role],
        )
        if (running.rowCount) throw new Error('tool_batch_not_terminal')
        const existing = await client.query<ToolProjectionRow>(
          `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text FROM tool_projection_versions
           WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
             AND visible_tool_names_json = $5::jsonb`,
          [input.executionId, input.role, input.stage, input.schemaHash,
            JSON.stringify(input.visibleToolNames)],
        )
        if (existing.rows[0]) {
          await client.query('COMMIT')
          return mapToolProjection(existing.rows[0])
        }
        const version = await client.query<{ next: number }>(
          `SELECT COALESCE(max(version), 0) + 1 AS next
           FROM tool_projection_versions WHERE execution_id = $1`, [input.executionId],
        )
        const next = Number(version.rows[0]!.next)
        const id = `${input.executionId}:tool-projection:${next}`
        const inserted = await client.query<ToolProjectionRow>(
          `INSERT INTO tool_projection_versions (
             id, execution_id, version, role, stage, schema_hash, projected_tools_json,
             visible_tool_names_json, reasons_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text`,
          [id, input.executionId, next, input.role, input.stage, input.schemaHash,
            JSON.stringify(input.projectedTools), JSON.stringify(input.visibleToolNames),
            JSON.stringify(input.reasons), input.createdAt],
        )
        await client.query('COMMIT')
        return mapToolProjection(inserted.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
    async recordModelRequest(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        const projection = await client.query(
          `SELECT id FROM tool_projection_versions WHERE id = $1 AND execution_id = $2`,
          [input.projectionId, input.executionId],
        )
        if (!projection.rowCount) throw new Error('tool_projection_not_available')
        await client.query(
          `INSERT INTO model_requests (id, execution_id, projection_id, turn_index, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
          [input.id, input.executionId, input.projectionId, input.turnIndex, input.createdAt],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async beginToolBatch(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number
      calls: Array<{ toolCallId: string; toolName: string; position: number }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        await client.query(
          `INSERT INTO tool_call_batches (
             id, execution_id, projection_id, turn_index, status, created_at
           ) VALUES ($1, $2, $3, $4, 'running', $5)`,
          [input.id, input.executionId, input.projectionId, input.turnIndex, input.createdAt],
        )
        for (const call of input.calls) await client.query(
          `INSERT INTO tool_batch_calls (batch_id, tool_call_id, tool_name, position)
           VALUES ($1, $2, $3, $4)`,
          [input.id, call.toolCallId, call.toolName, call.position],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async completeToolBatch(input: {
      id: string; executionId: string; status: 'completed' | 'failed' | 'cancelled'
      results: Array<{ toolCallId: string; status: 'completed' | 'failed' | 'cancelled'; completedAt: string }>
      completedAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        for (const result of input.results) {
          const updated = await client.query(
          `UPDATE tool_batch_calls SET status = $1, completed_at = $2
           WHERE batch_id = $3 AND tool_call_id = $4 AND status = 'running'`,
          [result.status, result.completedAt, input.id, result.toolCallId],
          )
          if (!updated.rowCount) throw new Error('tool_call_not_running')
        }
        const unsettled = await client.query(
          `SELECT tool_call_id FROM tool_batch_calls WHERE batch_id = $1 AND status = 'running' LIMIT 1`,
          [input.id],
        )
        if (unsettled.rowCount) throw new Error('tool_batch_not_terminal')
        const closed = await client.query(
          `UPDATE tool_call_batches SET status = $1, completed_at = $2
           WHERE id = $3 AND execution_id = $4 AND status = 'running'`,
          [input.status, input.completedAt, input.id, input.executionId],
        )
        if (!closed.rowCount) throw new Error('tool_batch_not_running')
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async replay(executionId: string) {
      const [projections, requests, batches, calls] = await Promise.all([
        pool.query<ToolProjectionRow>(
          `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text FROM tool_projection_versions
           WHERE execution_id = $1 ORDER BY version`, [executionId],
        ),
        pool.query<{ id: string; projection_version: number; turn_index: number; created_at: string }>(
          `SELECT request.id, projection.version AS projection_version, request.turn_index,
             request.created_at::text FROM model_requests request
           JOIN tool_projection_versions projection ON projection.id = request.projection_id
           WHERE request.execution_id = $1 ORDER BY request.turn_index`, [executionId],
        ),
        pool.query<{ id: string; turn_index: number; status: string; created_at: string; completed_at: string | null }>(
          `SELECT id, turn_index, status, created_at::text, completed_at::text
           FROM tool_call_batches WHERE execution_id = $1 ORDER BY turn_index`, [executionId],
        ),
        pool.query<{ batch_id: string; tool_call_id: string; tool_name: string; position: number; status: string; completed_at: string | null }>(
          `SELECT call.batch_id, call.tool_call_id, call.tool_name, call.position, call.status,
             call.completed_at::text FROM tool_batch_calls call
           JOIN tool_call_batches batch ON batch.id = call.batch_id
           WHERE batch.execution_id = $1 ORDER BY batch.turn_index, call.position`, [executionId],
        ),
      ])
      return {
        projections: projections.rows.map(mapToolProjection),
        modelRequests: requests.rows.map((row) => ({
          id: row.id, projectionVersion: row.projection_version, turnIndex: row.turn_index,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        toolBatches: batches.rows.map((batch) => ({
          id: batch.id, turnIndex: batch.turn_index, status: batch.status,
          calls: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, toolName: call.tool_name, position: call.position,
          })),
          results: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, status: call.status, completedAt: call.completed_at,
          })),
        })),
      }
    },
  }
}

export type ToolProjectionRepository = ReturnType<typeof createToolProjectionRepository>

async function assertCurrentExecution(database: PoolClient, executionId: string) {
  const execution = await database.query(
    `SELECT execution.id FROM agent_executions execution
     JOIN agent_sessions session ON session.id = execution.session_id
     WHERE execution.id = $1 AND session.execution_id = execution.id AND NOT execution.terminal
     FOR UPDATE OF execution`, [executionId],
  )
  if (!execution.rowCount) throw new Error('agent_execution_fenced')
}

function mapToolProjection(row: ToolProjectionRow) {
  return {
    id: row.id, executionId: row.execution_id, version: row.version, role: row.role,
    stage: row.stage, schemaHash: row.schema_hash, projectedTools: row.projected_tools_json,
    visibleToolNames: row.visible_tool_names_json,
    reasons: row.reasons_json, createdAt: new Date(row.created_at).toISOString(),
  }
}

function mapAgentEventRow(row: AgentEventRow): AgentEvent {
  return {
    sessionId: row.session_id,
    sequence: row.sequence,
    operationId: row.operation_id,
    payload: row.payload_json,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function isAgentExecutionStatus(value: string): value is AgentExecutionStatus {
  return agentExecutionStatuses.includes(value as AgentExecutionStatus)
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
    reportCreatedAt: row.report_created_at ? new Date(row.report_created_at).toISOString() : null,
    starred: row.starred, note: row.note,
    ...(row.terminal === null || row.terminal === undefined ? {} : { terminal: row.terminal }),
  }
}

function toPosition(row: PositionRow): ProductPosition {
  return {
    symbol: row.symbol,
    quantity: Number(row.quantity),
    averageCost: Number(row.average_cost),
  }
}
