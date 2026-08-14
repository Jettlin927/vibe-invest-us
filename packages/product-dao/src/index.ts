import { Pool, type PoolClient } from 'pg'
import {
  agentExecutionStatuses, aggregateModelTokenUsage, defaultRuntimeSettings, parseRuntimeSettingsUpdate,
  terminalAgentExecutionStatuses,
  type AgentExecutionStatus,
  type ExecutionSettingsSnapshot, type RuntimeSettings, type RuntimeSettingsRevision,
} from '@vibe-invest/contracts'

export const schemaVersion = 22

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
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS domain text;
UPDATE agent_sessions SET execution_id = 'legacy:' || id WHERE execution_id IS NULL;
ALTER TABLE agent_sessions ALTER COLUMN execution_id SET NOT NULL;
UPDATE agent_sessions SET is_primary = true
WHERE NOT EXISTS (
  SELECT 1 FROM agent_sessions primary_session
  WHERE primary_session.analysis_id = agent_sessions.analysis_id AND primary_session.is_primary
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_one_primary_per_analysis
ON agent_sessions (analysis_id) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_one_specialist_per_domain
ON agent_sessions (analysis_id, domain) WHERE domain IS NOT NULL;

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
ALTER TABLE conversation_segments ADD COLUMN IF NOT EXISTS parent_segment_id text
  REFERENCES conversation_segments(id);

CREATE TABLE IF NOT EXISTS agent_compactions (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  from_segment_id text NOT NULL REFERENCES conversation_segments(id),
  to_segment_id text NOT NULL REFERENCES conversation_segments(id),
  context_tokens integer NOT NULL CHECK (context_tokens >= 0),
  context_window integer NOT NULL CHECK (context_window > 0),
  reserve_tokens integer NOT NULL CHECK (reserve_tokens > 0),
  keep_recent_tokens integer NOT NULL CHECK (keep_recent_tokens > 0),
  tokens_after integer NOT NULL CHECK (tokens_after >= 0),
  summary_json jsonb NOT NULL CHECK (jsonb_typeof(summary_json) = 'object'),
  usage_json jsonb NOT NULL CHECK (jsonb_typeof(usage_json) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, to_segment_id)
);
ALTER TABLE agent_compactions ADD COLUMN IF NOT EXISTS tokens_after integer NOT NULL DEFAULT 0
  CHECK (tokens_after >= 0);

CREATE TABLE IF NOT EXISTS agent_compaction_attempts (
  compaction_id text NOT NULL,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt IN (1, 2)),
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  usage_json jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (compaction_id, attempt)
);

CREATE TABLE IF NOT EXISTS report_versions (
  id text PRIMARY KEY,
  analysis_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('integrated', 'specialist')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  report_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, version),
  UNIQUE (execution_id, payload_hash)
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
  role text NOT NULL CONSTRAINT tool_projection_versions_role_check
    CHECK (role IN ('main', 'fundamental', 'news', 'technical')),
  stage text NOT NULL CONSTRAINT tool_projection_versions_stage_check
    CHECK (stage IN ('research', 'finalization')),
  schema_hash text NOT NULL CHECK (schema_hash <> ''),
  projected_tools_json jsonb NOT NULL CHECK (jsonb_typeof(projected_tools_json) = 'array'),
  visible_tool_names_json jsonb NOT NULL CHECK (jsonb_typeof(visible_tool_names_json) = 'array'),
  reasons_json jsonb NOT NULL CHECK (jsonb_typeof(reasons_json) = 'object'),
  created_at timestamptz NOT NULL,
  CONSTRAINT tool_projection_execution_unique UNIQUE (id, execution_id),
  UNIQUE (execution_id, version),
  UNIQUE (execution_id, role, stage, schema_hash, visible_tool_names_json)
);

CREATE TABLE IF NOT EXISTS model_requests (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  projection_id text NOT NULL,
  turn_index integer NOT NULL CHECK (turn_index > 0),
  kind text NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'compaction')),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'cancelled', 'outcome_unknown')),
  usage_status text NOT NULL DEFAULT 'unknown'
    CHECK (usage_status IN ('complete', 'partial', 'unknown')),
  input_tokens integer CHECK (input_tokens >= 0),
  cache_read_tokens integer CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer CHECK (cache_write_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  total_tokens integer CHECK (total_tokens >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT model_requests_projection_id_execution_id_fkey FOREIGN KEY (projection_id, execution_id)
    REFERENCES tool_projection_versions(id, execution_id)
);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'turn'
  CHECK (kind IN ('turn', 'compaction'));
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'started'
  CHECK (status IN ('started', 'completed', 'failed', 'cancelled', 'outcome_unknown'));
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS usage_status text NOT NULL DEFAULT 'unknown'
  CHECK (usage_status IN ('complete', 'partial', 'unknown'));
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens >= 0);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS cache_read_tokens integer CHECK (cache_read_tokens >= 0);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS cache_write_tokens integer CHECK (cache_write_tokens >= 0);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens >= 0);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS total_tokens integer CHECK (total_tokens >= 0);
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE model_requests DROP CONSTRAINT IF EXISTS model_requests_usage_consistency_check;
ALTER TABLE model_requests ADD CONSTRAINT model_requests_usage_consistency_check CHECK (
  (usage_status = 'unknown' AND input_tokens IS NULL AND cache_read_tokens IS NULL
    AND cache_write_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL)
  OR (usage_status = 'complete' AND input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL
    AND cache_write_tokens IS NOT NULL AND output_tokens IS NOT NULL AND total_tokens IS NOT NULL
    AND total_tokens = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens)
  OR (usage_status = 'partial' AND num_nonnulls(
    input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens
  ) BETWEEN 1 AND 5 AND NOT (
    input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL
    AND cache_write_tokens IS NOT NULL AND output_tokens IS NOT NULL
    AND total_tokens IS NOT NULL
    AND total_tokens = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens
  ))
);

CREATE TABLE IF NOT EXISTS tool_call_batches (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  projection_id text NOT NULL,
  turn_index integer NOT NULL CHECK (turn_index > 0),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT tool_call_batches_projection_id_execution_id_fkey FOREIGN KEY (projection_id, execution_id)
    REFERENCES tool_projection_versions(id, execution_id),
  CONSTRAINT tool_call_batches_completion_check
    CHECK ((status = 'running') = (completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS tool_batch_calls (
  batch_id text NOT NULL REFERENCES tool_call_batches(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL CHECK (tool_name <> ''),
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  completion_order integer CHECK (completion_order > 0),
  result_payload_json jsonb,
  PRIMARY KEY (batch_id, tool_call_id),
  UNIQUE (batch_id, position),
  UNIQUE (batch_id, completion_order),
  CONSTRAINT tool_batch_calls_completion_check
    CHECK ((status = 'running') = (completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS tool_event_migration_provenance (
  session_id text NOT NULL,
  sequence integer NOT NULL,
  provenance text NOT NULL CHECK (provenance = 'pre_registry_v12'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id, sequence) REFERENCES agent_events(session_id, sequence) ON DELETE CASCADE
);

ALTER TABLE model_requests DROP CONSTRAINT IF EXISTS model_requests_projection_id_fkey;
ALTER TABLE model_requests DROP CONSTRAINT IF EXISTS model_requests_projection_id_execution_id_fkey;
ALTER TABLE tool_call_batches DROP CONSTRAINT IF EXISTS tool_call_batches_projection_id_fkey;
ALTER TABLE tool_call_batches DROP CONSTRAINT IF EXISTS tool_call_batches_projection_id_execution_id_fkey;
ALTER TABLE tool_projection_versions
  DROP CONSTRAINT IF EXISTS tool_projection_execution_unique;
ALTER TABLE tool_projection_versions
  ADD CONSTRAINT tool_projection_execution_unique UNIQUE (id, execution_id);
ALTER TABLE model_requests ADD CONSTRAINT model_requests_projection_id_execution_id_fkey
  FOREIGN KEY (projection_id, execution_id)
  REFERENCES tool_projection_versions(id, execution_id);
ALTER TABLE tool_call_batches ADD CONSTRAINT tool_call_batches_projection_id_execution_id_fkey
  FOREIGN KEY (projection_id, execution_id)
  REFERENCES tool_projection_versions(id, execution_id);
ALTER TABLE tool_call_batches DROP CONSTRAINT IF EXISTS tool_call_batches_completion_check;
ALTER TABLE tool_call_batches ADD CONSTRAINT tool_call_batches_completion_check
  CHECK ((status = 'running') = (completed_at IS NULL));
ALTER TABLE tool_batch_calls DROP CONSTRAINT IF EXISTS tool_batch_calls_completion_check;
ALTER TABLE tool_batch_calls ADD CONSTRAINT tool_batch_calls_completion_check
  CHECK ((status = 'running') = (completed_at IS NULL));
ALTER TABLE tool_projection_versions DROP CONSTRAINT IF EXISTS tool_projection_versions_role_check;
UPDATE tool_projection_versions SET role = 'fundamental' WHERE role = 'fundamental_specialist';
ALTER TABLE tool_projection_versions ADD CONSTRAINT tool_projection_versions_role_check
  CHECK (role IN ('main', 'fundamental', 'news', 'technical'));
ALTER TABLE tool_projection_versions DROP CONSTRAINT IF EXISTS tool_projection_versions_stage_check;
ALTER TABLE tool_projection_versions ADD CONSTRAINT tool_projection_versions_stage_check
  CHECK (stage IN ('research', 'finalization'));
ALTER TABLE tool_batch_calls ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE tool_batch_calls ADD COLUMN IF NOT EXISTS completion_order integer;
ALTER TABLE tool_batch_calls ADD COLUMN IF NOT EXISTS result_payload_json jsonb;
ALTER TABLE tool_batch_calls DROP CONSTRAINT IF EXISTS tool_batch_calls_completion_order_check;
ALTER TABLE tool_batch_calls ADD CONSTRAINT tool_batch_calls_completion_order_check
  CHECK (completion_order IS NULL OR completion_order > 0);
CREATE UNIQUE INDEX IF NOT EXISTS tool_batch_calls_completion_order_unique
  ON tool_batch_calls (batch_id, completion_order) WHERE completion_order IS NOT NULL;
ALTER TABLE tool_batch_calls DROP CONSTRAINT IF EXISTS tool_batch_calls_completion_check;
ALTER TABLE tool_batch_calls ADD CONSTRAINT tool_batch_calls_completion_check CHECK (
  (status = 'running' AND completed_at IS NULL AND completion_order IS NULL
    AND result_payload_json IS NULL)
  OR
  (status <> 'running' AND (started_at IS NOT NULL OR status = 'cancelled')
    AND completed_at IS NOT NULL
    AND completion_order IS NOT NULL AND result_payload_json IS NOT NULL)
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

INSERT INTO product_schema_migrations (version)
VALUES (14)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (15)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (16)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (17)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (18)
ON CONFLICT (version) DO NOTHING;

ALTER TABLE tool_projection_versions DROP CONSTRAINT IF EXISTS tool_projection_versions_role_check;
ALTER TABLE tool_projection_versions ADD CONSTRAINT tool_projection_versions_role_check
  CHECK (role IN ('main', 'fundamental', 'news', 'technical'));

INSERT INTO product_schema_migrations (version)
VALUES (19)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (20)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (21)
ON CONFLICT (version) DO NOTHING;

UPDATE model_requests SET status = 'outcome_unknown', completed_at = created_at
WHERE status = 'started' AND EXISTS (
  SELECT 1 FROM product_schema_migrations WHERE version = 21
) AND NOT EXISTS (
  SELECT 1 FROM product_schema_migrations WHERE version = 22
);

UPDATE model_requests SET kind = 'compaction'
WHERE id ~ ':compaction:[^:]+:attempt:[0-9]+$' AND EXISTS (
  SELECT 1 FROM product_schema_migrations WHERE version = 21
) AND NOT EXISTS (
  SELECT 1 FROM product_schema_migrations WHERE version = 22
);

INSERT INTO product_schema_migrations (version)
VALUES (22)
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
GRANT SELECT, INSERT ON agent_compactions TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_compaction_attempts TO vibe_invest_app;
GRANT SELECT, INSERT ON runtime_settings_revisions, execution_settings_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON tool_projection_versions, model_requests, tool_call_batches, tool_batch_calls TO vibe_invest_app;
GRANT UPDATE (
  status, usage_status, input_tokens, cache_read_tokens, cache_write_tokens,
  output_tokens, total_tokens, completed_at
) ON model_requests TO vibe_invest_app;
GRANT SELECT, INSERT ON report_versions TO vibe_invest_app;
GRANT UPDATE (status, started_at, completed_at, completion_order, result_payload_json)
  ON tool_batch_calls TO vibe_invest_app;
GRANT UPDATE (status, completed_at) ON tool_call_batches TO vibe_invest_app;
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
    const existingTables = await client.query<{ migration_exists: boolean; events_exist: boolean }>(
      `SELECT
         to_regclass('public.product_schema_migrations') IS NOT NULL AS migration_exists,
         to_regclass('public.agent_events') IS NOT NULL AS events_exist`,
    )
    let maxVersion = 0
    if (existingTables.rows[0]?.migration_exists) {
      const existing = await client.query<{ max_version: number }>(
        `SELECT COALESCE(max(version), 0)::integer AS max_version
         FROM product_schema_migrations`,
      )
      maxVersion = existing.rows[0]!.max_version
      if (maxVersion >= 13 && maxVersion <= 15) {
        throw new Error(`product_schema_intermediate_candidate_unsupported:${maxVersion}`)
      }
      if (maxVersion > schemaVersion) {
        throw new Error(`product_schema_future_version_unsupported:${maxVersion}`)
      }
    }
    if (maxVersion <= 12 && existingTables.rows[0]?.events_exist) {
      await client.query(
      `CREATE TABLE IF NOT EXISTS tool_event_migration_provenance (
         session_id text NOT NULL,
         sequence integer NOT NULL,
         provenance text NOT NULL CHECK (provenance = 'pre_registry_v12'),
         recorded_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (session_id, sequence),
         FOREIGN KEY (session_id, sequence) REFERENCES agent_events(session_id, sequence) ON DELETE CASCADE
       );
       INSERT INTO tool_event_migration_provenance (session_id, sequence, provenance)
       SELECT session_id, sequence, 'pre_registry_v12'
       FROM agent_events
       WHERE payload_json->>'type' IN ('tool_call', 'tool_result')
       ON CONFLICT (session_id, sequence) DO NOTHING`,
      )
    }
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
      await pool.query(
        `UPDATE analyses SET snapshot_json = $1
         WHERE id = $2 AND NOT (status = ANY($3::text[]))`,
        [JSON.stringify(snapshot), id, terminal],
      )
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
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          'SELECT analysis_id FROM agent_sessions WHERE id = $1', [input.sessionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          latest_sequence: number; analysis_id: string; is_primary: boolean; execution_id: string
        }>(
          `SELECT latest_sequence, analysis_id, is_primary, execution_id
           FROM agent_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].execution_id !== input.executionId) {
          const existing = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [input.sessionId, input.operationId],
          )
          const row = existing.rows[0]
          if (!row || session.rows[0].execution_id !== input.fenceExecutionId
            || !jsonValuesEqual(row.payload_json, input.event)
            || !sameInstant(row.created_at, input.createdAt)) throw new Error('agent_execution_fenced')
          const cancelled = await client.query<AgentEventRow>(
            `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text
             FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
             WHERE s.analysis_id = $1 AND e.created_at = $2
               AND e.operation_id LIKE '%:cancelled-%' ORDER BY e.session_id, e.sequence`,
            [session.rows[0].analysis_id, input.createdAt],
          )
          const fenced = await client.query<AgentEventRow & { execution_id: string }>(
            `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text,
                    s.execution_id
             FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
             WHERE s.analysis_id = $1 AND e.created_at = $2
               AND e.payload_json->>'status' = 'stopping' ORDER BY e.session_id`,
            [session.rows[0].analysis_id, input.createdAt],
          )
          await client.query('COMMIT')
          return {
            ...mapAgentEventRow(row), executionId: input.fenceExecutionId,
            cancelledToolEvents: cancelled.rows.map(mapAgentEventRow),
            fencedSessions: fenced.rows.map((event) => ({
              ...mapAgentEventRow(event), executionId: event.execution_id,
            })),
          }
        }
        const sessions = await client.query<{
          id: string; execution_id: string; latest_sequence: number; is_primary: boolean
        }>(
          `SELECT id, execution_id, latest_sequence, is_primary FROM agent_sessions
           WHERE analysis_id = $1 ORDER BY id FOR UPDATE`, [session.rows[0].analysis_id],
        )
        const fencedSessions: Array<AgentEvent & { executionId: string }> = []
        const cancelledToolEvents: AgentEvent[] = []
        for (const currentSession of sessions.rows) {
          const execution = await client.query<{ generation: number; terminal: boolean }>(
            'SELECT generation, terminal FROM agent_executions WHERE id = $1 FOR UPDATE',
            [currentSession.execution_id],
          )
          if (!execution.rows[0]) throw new Error('agent_execution_not_found')
          if (execution.rows[0].terminal) {
            if (currentSession.id === input.sessionId) throw new Error('agent_execution_terminal')
            continue
          }
          const cancelled = await cancelRunningToolBatches(
            client, currentSession.id, currentSession.execution_id,
            currentSession.latest_sequence, input.createdAt,
          )
          cancelledToolEvents.push(...cancelled.events)
          await cancelRunningCompactionAttempts(
            client, currentSession.id, currentSession.execution_id, input.createdAt,
          )
          await finalizeRunningModelRequests(
            client, currentSession.execution_id, 'cancelled', input.createdAt,
          )
          const sequence = cancelled.latestSequence + 1
          const waitReason = input.event.waitReason ?? null
          const fenceExecutionId = currentSession.id === input.sessionId
            ? input.fenceExecutionId : `${input.fenceExecutionId}:session:${currentSession.id}`
          const operationId = currentSession.id === input.sessionId
            ? input.operationId : `${input.operationId}:session:${currentSession.id}`
          await client.query(
            'UPDATE agent_executions SET terminal = true, updated_at = $1 WHERE id = $2',
            [input.createdAt, currentSession.execution_id],
          )
          await client.query(
            `INSERT INTO agent_executions (
               id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
             ) VALUES ($1, $2, $3, 'stopping', $4, false, $5, $5)`,
            [fenceExecutionId, currentSession.id, execution.rows[0].generation + 1,
              waitReason ? JSON.stringify(waitReason) : null, input.createdAt],
          )
          const eventPayload = currentSession.id === input.sessionId ? input.event : {
            ...input.event, previousExecutionId: currentSession.execution_id,
          }
          await client.query(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [currentSession.id, sequence, operationId, JSON.stringify(eventPayload), input.createdAt],
          )
          await client.query(
            `UPDATE agent_sessions SET execution_id = $1, status = 'stopping', latest_sequence = $2,
               updated_at = $3 WHERE id = $4`,
            [fenceExecutionId, sequence, input.createdAt, currentSession.id],
          )
          fencedSessions.push({
            sessionId: currentSession.id, sequence, operationId, payload: eventPayload,
            createdAt: input.createdAt, executionId: fenceExecutionId,
          })
        }
        if (session.rows[0].is_primary) await client.query(
          `UPDATE analyses SET status = 'stopping', active = true, updated_at = $1 WHERE id = $2`,
          [input.createdAt, session.rows[0].analysis_id],
        )
        await client.query('COMMIT')
        const primary = fencedSessions.find(({ sessionId }) => sessionId === input.sessionId)!
        return { ...primary, cancelledToolEvents, fencedSessions }
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
    async resumeResearch(input: {
      analysisId: string; executionId: string; segmentId?: string
      operationId: string; event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ status: string }>(
          'SELECT status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rows[0]) throw new Error('analysis_not_found')
        const session = await client.query<{
          id: string; execution_id: string; latest_sequence: number
        }>(
          `SELECT id, execution_id, latest_sequence FROM agent_sessions
           WHERE analysis_id = $1 AND is_primary FOR UPDATE`, [input.analysisId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const current = await client.query<{
          id: string; generation: number; status: string; terminal: boolean
        }>(
          `SELECT id, generation, status, terminal FROM agent_executions
           WHERE id = $1 FOR UPDATE`, [session.rows[0].execution_id],
        )
        if (!current.rows[0]) throw new Error('agent_execution_not_found')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (replay.rows[0]) {
          const execution = await client.query<{ session_id: string; generation: number }>(
            'SELECT session_id, generation FROM agent_executions WHERE id = $1', [input.executionId],
          )
          if (execution.rows[0]?.session_id !== session.rows[0].id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: session.rows[0].id, executionId: input.executionId,
            generation: execution.rows[0].generation, created: false,
          }
        }
        if (!current.rows[0].terminal
          || !['stopped', 'interrupted'].includes(current.rows[0].status)
          || !['stopped', 'interrupted'].includes(analysis.rows[0].status)) {
          throw new Error('analysis_not_resumable')
        }
        const generation = current.rows[0].generation + 1
        const sequence = session.rows[0].latest_sequence + 1
        const segment = await client.query<{ next_ordinal: number }>(
          `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS next_ordinal
           FROM conversation_segments WHERE session_id = $1`, [session.rows[0].id],
        )
        const ordinal = segment.rows[0]!.next_ordinal
        const waitReason = { kind: 'database', target: '恢复研究上下文', startedAt: input.createdAt }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
          [input.executionId, session.rows[0].id, generation,
            JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, $3, $4)`,
          [input.segmentId ?? `${session.rows[0].id}:segment:${ordinal}`,
            session.rows[0].id, ordinal, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'planning', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.executionId, sequence, input.createdAt, session.rows[0].id],
        )
        await client.query(
          `UPDATE analyses SET status = 'queued', active = true, error = NULL, updated_at = $1
           WHERE id = $2`, [input.createdAt, input.analysisId],
        )
        await client.query('COMMIT')
        return {
          sessionId: session.rows[0].id, executionId: input.executionId, generation, created: true,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async createFollowUpExecution(input: {
      analysisId: string; executionId: string; segmentId?: string
      baseReportVersion: number | null; operationId: string
      event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const eventBaseReportVersion = typeof input.event.baseReportVersion === 'number'
          ? input.event.baseReportVersion : input.event.baseReportVersion === null ? null : undefined
        if (eventBaseReportVersion !== input.baseReportVersion) {
          throw new Error('agent_operation_conflict')
        }
        const analysis = await client.query<{ status: string }>(
          'SELECT status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rows[0]) throw new Error('analysis_not_found')
        const session = await client.query<{
          id: string; execution_id: string; latest_sequence: number
        }>(
          `SELECT id, execution_id, latest_sequence FROM agent_sessions
           WHERE analysis_id = $1 AND is_primary FOR UPDATE`, [input.analysisId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (replay.rows[0]) {
          const execution = await client.query<{ session_id: string; generation: number }>(
            'SELECT session_id, generation FROM agent_executions WHERE id = $1',
            [input.executionId],
          )
          if (execution.rows[0]?.session_id !== session.rows[0].id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: session.rows[0].id, executionId: input.executionId,
            generation: execution.rows[0].generation,
            baseReportVersion: eventBaseReportVersion, created: false,
          }
        }
        const current = await client.query<{
          generation: number; status: string; terminal: boolean
        }>(
          `SELECT generation, status, terminal FROM agent_executions WHERE id = $1 FOR UPDATE`,
          [session.rows[0].execution_id],
        )
        if (!current.rows[0]?.terminal) throw new Error('analysis_follow_up_not_available')
        if (['stopped', 'interrupted'].includes(current.rows[0].status)) {
          throw new Error('analysis_resume_required')
        }
        if (input.baseReportVersion !== null) {
          const report = await client.query(
            `SELECT id FROM report_versions
             WHERE analysis_id = $1 AND session_id = $2 AND version = $3 AND kind = 'integrated'`,
            [input.analysisId, session.rows[0].id, input.baseReportVersion],
          )
          if (!report.rowCount) throw new Error('base_report_version_not_found')
        }
        const generation = current.rows[0].generation + 1
        const sequence = session.rows[0].latest_sequence + 1
        const ordinalResult = await client.query<{ ordinal: number }>(
          `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS ordinal
           FROM conversation_segments WHERE session_id = $1`, [session.rows[0].id],
        )
        const ordinal = ordinalResult.rows[0]!.ordinal
        const waitReason = {
          kind: 'database', target: '组装追问上下文', startedAt: input.createdAt,
        }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
          [input.executionId, session.rows[0].id, generation,
            JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, $3, $4)`,
          [input.segmentId ?? `${session.rows[0].id}:segment:${ordinal}`,
            session.rows[0].id, ordinal, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query(
          `UPDATE agent_sessions SET execution_id = $1, status = 'planning', latest_sequence = $2,
             updated_at = $3 WHERE id = $4`,
          [input.executionId, sequence, input.createdAt, session.rows[0].id],
        )
        await client.query(
          `UPDATE analyses SET status = 'queued', active = true, error = NULL, updated_at = $1
           WHERE id = $2`, [input.createdAt, input.analysisId],
        )
        await client.query('COMMIT')
        return {
          sessionId: session.rows[0].id, executionId: input.executionId,
          generation, baseReportVersion: input.baseReportVersion, created: true,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
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
    async createSpecialistSession(input: {
      id: string; analysisId: string; domain: 'news' | 'fundamental_valuation' | 'technical'
      executionId: string; segmentId?: string; status: string; operationId: string
      event: Record<string, unknown>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const analysis = await client.query<{ active: boolean; status: string }>(
          'SELECT active, status FROM analyses WHERE id = $1 FOR UPDATE', [input.analysisId],
        )
        if (!analysis.rowCount) throw new Error('analysis_not_found')
        const replay = await client.query<AgentEventRow & { session_id: string }>(
          `SELECT e.session_id, e.sequence, e.operation_id, e.payload_json, e.created_at::text
           FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
           WHERE s.analysis_id = $1 AND s.domain = $2 AND e.operation_id = $3`,
          [input.analysisId, input.domain, input.operationId],
        )
        if (replay.rows[0]) {
          const replayExecution = await client.query<{ session_id: string }>(
            'SELECT session_id FROM agent_executions WHERE id = $1', [input.executionId],
          )
          if (replayExecution.rows[0]?.session_id !== replay.rows[0].session_id
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return {
            sessionId: replay.rows[0].session_id, executionId: input.executionId, created: false,
          }
        }
        if (!analysis.rows[0]!.active || ['stopping', 'completed', 'partial', 'failed', 'stopped',
          'interrupted', 'budget_exhausted'].includes(analysis.rows[0]!.status)) {
          throw new Error('analysis_not_active')
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO agent_sessions (
             id, analysis_id, is_primary, domain, execution_id, status,
             latest_sequence, created_at, updated_at
           ) VALUES ($1, $2, false, $3, $4, $5, 1, $6, $6)
           ON CONFLICT (analysis_id, domain) WHERE domain IS NOT NULL DO NOTHING
           RETURNING id`,
          [input.id, input.analysisId, input.domain, input.executionId, input.status, input.createdAt],
        )
        if (!inserted.rows[0]) {
          const existing = await client.query<{
            id: string; execution_id: string; latest_sequence: number
          }>(
            `SELECT id, execution_id, latest_sequence FROM agent_sessions
             WHERE analysis_id = $1 AND domain = $2 FOR UPDATE`, [input.analysisId, input.domain],
          )
          const session = existing.rows[0]!
          const replay = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [session.id, input.operationId],
          )
          if (replay.rows[0]) {
            const replayExecution = await client.query<{ session_id: string }>(
              'SELECT session_id FROM agent_executions WHERE id = $1', [input.executionId],
            )
            if (replayExecution.rows[0]?.session_id !== session.id
              || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
              || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
              throw new Error('agent_operation_conflict')
            }
            await client.query('COMMIT')
            return { sessionId: session.id, executionId: input.executionId, created: false }
          }
          const current = await client.query<{ generation: number; terminal: boolean }>(
            `SELECT generation, terminal FROM agent_executions
             WHERE id = $1 FOR UPDATE`, [session.execution_id],
          )
          if (!current.rows[0]?.terminal) {
            await client.query('COMMIT')
            return { sessionId: session.id, executionId: session.execution_id, created: false }
          }
          const sequence = session.latest_sequence + 1
          const generation = current.rows[0].generation + 1
          const segment = await client.query<{ next_ordinal: number }>(
            `SELECT COALESCE(max(ordinal), 0)::integer + 1 AS next_ordinal
             FROM conversation_segments WHERE session_id = $1`, [session.id],
          )
          const ordinal = segment.rows[0]!.next_ordinal
          const waitReason = { kind: 'database', target: '专项研究规划', startedAt: input.createdAt }
          await client.query(
            `INSERT INTO agent_executions (
               id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
             ) VALUES ($1, $2, $3, 'planning', $4, false, $5, $5)`,
            [input.executionId, session.id, generation, JSON.stringify(waitReason), input.createdAt],
          )
          await client.query(
            `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
             VALUES ($1, $2, $3, $4)`,
            [input.segmentId ?? `${session.id}:segment:${ordinal}`, session.id, ordinal, input.createdAt],
          )
          await client.query(
            `INSERT INTO agent_events (
               session_id, sequence, operation_id, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [session.id, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
          )
          await freezeExecutionSettings(client, input.executionId, input.createdAt)
          await client.query(
            `UPDATE agent_sessions SET execution_id = $1, status = 'planning',
               latest_sequence = $2, updated_at = $3 WHERE id = $4`,
            [input.executionId, sequence, input.createdAt, session.id],
          )
          await client.query('COMMIT')
          return { sessionId: session.id, executionId: input.executionId, created: true }
        }
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, 1, $2, $3, $4)`,
          [input.id, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        const waitReason = { kind: 'database', target: '专项研究规划', startedAt: input.createdAt }
        await client.query(
          `INSERT INTO agent_executions (
             id, session_id, generation, status, wait_reason_json, terminal, created_at, updated_at
           ) VALUES ($1, $2, 1, 'planning', $3, false, $4, $4)`,
          [input.executionId, input.id, JSON.stringify(waitReason), input.createdAt],
        )
        await client.query(
          `INSERT INTO conversation_segments (id, session_id, ordinal, created_at)
           VALUES ($1, $2, 1, $3)`,
          [input.segmentId ?? `${input.id}:segment:1`, input.id, input.createdAt],
        )
        await freezeExecutionSettings(client, input.executionId, input.createdAt)
        await client.query('COMMIT')
        return { sessionId: input.id, executionId: input.executionId, created: true }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
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
        reportVersion?: {
          id: string
          kind: 'integrated' | 'specialist'
          payloadHash: string
          report: unknown
        }
      }
      createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          'SELECT analysis_id FROM agent_sessions WHERE id = $1', [input.sessionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
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
        let cancelledToolEvents: AgentEvent[] = []
        let sequence = session.rows[0].latest_sequence + 1
        if (input.projection?.executionStatus
          && (input.projection.terminal ?? input.event.terminal === true)) {
          const cancelled = await cancelRunningToolBatches(
            client, input.sessionId, current.id, session.rows[0].latest_sequence, input.createdAt,
          )
          cancelledToolEvents = cancelled.events
          sequence = cancelled.latestSequence + 1
          await finalizeRunningModelRequests(
            client, current.id, 'outcome_unknown', input.createdAt,
          )
        }
        await client.query(
          `INSERT INTO agent_events (
             session_id, sequence, operation_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        if (input.projection?.reportVersion) {
          const reportVersion = input.projection.reportVersion
          const nextVersion = await client.query<{ version: number }>(
            `SELECT COALESCE(max(version), 0)::integer + 1 AS version
             FROM report_versions WHERE session_id = $1`,
            [input.sessionId],
          )
          await client.query(
            `INSERT INTO report_versions (
               id, analysis_id, session_id, execution_id, version,
               kind, payload_hash, report_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [reportVersion.id, session.rows[0].analysis_id, input.sessionId, input.executionId,
              nextVersion.rows[0]!.version, reportVersion.kind, reportVersion.payloadHash,
              JSON.stringify(reportVersion.report), input.createdAt],
          )
        }
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
        return { sequence, created: true, cancelledToolEvents, event: {
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
    async listReportVersions(analysisId: string) {
      const result = await pool.query<{
        id: string; analysis_id: string; session_id: string; execution_id: string
        version: number; kind: 'integrated' | 'specialist'; payload_hash: string
        report_json: unknown; created_at: string
      }>(
        `SELECT id, analysis_id, session_id, execution_id, version, kind,
                payload_hash, report_json, created_at::text
         FROM report_versions WHERE analysis_id = $1 ORDER BY created_at, id`,
        [analysisId],
      )
      return result.rows.map((row) => ({
        id: row.id, analysisId: row.analysis_id, sessionId: row.session_id,
        executionId: row.execution_id, version: row.version, kind: row.kind,
        payloadHash: row.payload_hash, report: row.report_json,
        createdAt: new Date(row.created_at).toISOString(),
      }))
    },
    async commitCompaction(input: {
      id: string; executionId: string; segmentId: string
      operationId: string; event: Record<string, unknown>
      contextTokens: number; contextWindow: number; reserveTokens: number
      keepRecentTokens: number; tokensAfter: number; summary: Record<string, unknown>
      usage: Record<string, unknown>; attempts: Array<{
        attempt: number; status: 'completed' | 'failed' | 'cancelled'
        durationMs: number; usage: unknown
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ analysis_id: string; session_id: string }>(
          `SELECT session.analysis_id, session.id AS session_id
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
        )
        const session = await client.query<{
          execution_id: string; latest_sequence: number
        }>(
          `SELECT execution_id, latest_sequence FROM agent_sessions
           WHERE id = $1 FOR UPDATE`, [identity.rows[0].session_id],
        )
        if (session.rows[0]?.execution_id !== input.executionId) {
          throw new Error('agent_execution_fenced')
        }
        const execution = await client.query<{ terminal: boolean }>(
          'SELECT terminal FROM agent_executions WHERE id = $1 FOR UPDATE', [input.executionId],
        )
        if (!execution.rows[0] || execution.rows[0].terminal) throw new Error('agent_execution_fenced')
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [identity.rows[0].session_id, input.operationId],
        )
        if (replay.rows[0]) {
          const compacted = await client.query<{
            id: string; from_segment_id: string; to_segment_id: string
            parent_segment_id: string | null
            context_tokens: number; context_window: number; reserve_tokens: number
            keep_recent_tokens: number; tokens_after: number
            summary_json: Record<string, unknown>; usage_json: Record<string, unknown>; created_at: string
          }>(
            `SELECT compaction.id, compaction.from_segment_id, compaction.to_segment_id,
                    target.parent_segment_id,
                    compaction.context_tokens, compaction.context_window,
                    compaction.reserve_tokens, compaction.keep_recent_tokens,
                    compaction.tokens_after, compaction.summary_json,
                    compaction.usage_json, compaction.created_at::text
             FROM agent_compactions compaction
             JOIN conversation_segments target ON target.id = compaction.to_segment_id
             WHERE compaction.id = $1`, [input.id],
          )
          const attempts = await client.query<{
            attempt: number; status: string; duration_ms: number; usage_json: unknown
          }>(
            `SELECT attempt, status, duration_ms, usage_json
             FROM agent_compaction_attempts WHERE compaction_id = $1 ORDER BY attempt`, [input.id],
          )
          if (!compacted.rows[0] || compacted.rows[0].to_segment_id !== input.segmentId
            || compacted.rows[0].parent_segment_id !== compacted.rows[0].from_segment_id
            || compacted.rows[0].context_tokens !== input.contextTokens
            || compacted.rows[0].context_window !== input.contextWindow
            || compacted.rows[0].reserve_tokens !== input.reserveTokens
            || compacted.rows[0].keep_recent_tokens !== input.keepRecentTokens
            || compacted.rows[0].tokens_after !== input.tokensAfter
            || !jsonValuesEqual(compacted.rows[0].summary_json, input.summary)
            || !jsonValuesEqual(compacted.rows[0].usage_json, input.usage)
            || !jsonValuesEqual(attempts.rows.map((attempt) => ({
              attempt: attempt.attempt, status: attempt.status,
              durationMs: attempt.duration_ms, usage: attempt.usage_json,
            })), input.attempts)
            || !jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(compacted.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          await client.query('COMMIT')
          return { created: false, event: mapAgentEventRow(replay.rows[0]), segmentId: input.segmentId }
        }
        const currentSegment = await client.query<{ id: string; ordinal: number }>(
          `SELECT id, ordinal FROM conversation_segments WHERE session_id = $1
           ORDER BY ordinal DESC LIMIT 1`, [identity.rows[0].session_id],
        )
        if (!currentSegment.rows[0]) throw new Error('conversation_segment_not_found')
        const sequence = session.rows[0].latest_sequence + 1
        await client.query(
          `INSERT INTO conversation_segments (
             id, session_id, ordinal, parent_segment_id, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.segmentId, identity.rows[0].session_id, currentSegment.rows[0].ordinal + 1,
            currentSegment.rows[0].id, input.createdAt],
        )
        await client.query(
          `INSERT INTO agent_compactions (
             id, session_id, execution_id, from_segment_id, to_segment_id,
             context_tokens, context_window, reserve_tokens, keep_recent_tokens,
             tokens_after, summary_json, usage_json, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [input.id, identity.rows[0].session_id, input.executionId, currentSegment.rows[0].id,
            input.segmentId, input.contextTokens, input.contextWindow, input.reserveTokens,
            input.keepRecentTokens, input.tokensAfter, JSON.stringify(input.summary),
            JSON.stringify(input.usage), input.createdAt],
        )
        await insertCompactionAttempts(
          client, input.id, identity.rows[0].session_id, input.executionId,
          input.attempts, input.createdAt,
        )
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [identity.rows[0].session_id, sequence, input.operationId,
            JSON.stringify(input.event), input.createdAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, identity.rows[0].session_id],
        )
        await client.query('COMMIT')
        return {
          created: true, segmentId: input.segmentId,
          event: {
            sessionId: identity.rows[0].session_id, sequence, operationId: input.operationId,
            payload: input.event, createdAt: input.createdAt,
          },
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async failCompaction(input: {
      id: string; executionId: string; operationId: string
      event: Record<string, unknown>; attempts: Array<{
        attempt: number; status: 'failed' | 'cancelled'; durationMs: number; usage: unknown
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ session_id: string }>(
          `SELECT session.id AS session_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await assertCurrentExecution(client, input.executionId)
        const sessionId = identity.rows[0].session_id
        const session = await client.query<{ latest_sequence: number }>(
          'SELECT latest_sequence FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [sessionId],
        )
        const replay = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [sessionId, input.operationId],
        )
        if (replay.rows[0]) {
          const attempts = await client.query<{
            attempt: number; status: string; duration_ms: number; usage_json: unknown
          }>(
            `SELECT attempt, status, duration_ms, usage_json
             FROM agent_compaction_attempts WHERE compaction_id = $1 ORDER BY attempt`, [input.id],
          )
          if (!jsonValuesEqual(replay.rows[0].payload_json, input.event)
            || !sameInstant(replay.rows[0].created_at, input.createdAt)) {
            throw new Error('agent_operation_conflict')
          }
          if (!jsonValuesEqual(attempts.rows.map((attempt) => ({
            attempt: attempt.attempt, status: attempt.status,
            durationMs: attempt.duration_ms, usage: attempt.usage_json,
          })), input.attempts)) throw new Error('agent_operation_conflict')
          await client.query('COMMIT')
          return { created: false, event: mapAgentEventRow(replay.rows[0]) }
        }
        await insertCompactionAttempts(
          client, input.id, sessionId, input.executionId, input.attempts, input.createdAt,
        )
        const sequence = session.rows[0]!.latest_sequence + 1
        await client.query(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [sessionId, sequence, input.operationId, JSON.stringify(input.event), input.createdAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, sessionId],
        )
        await client.query('COMMIT')
        return { created: true, event: {
          sessionId, sequence, operationId: input.operationId,
          payload: input.event, createdAt: input.createdAt,
        } }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async recordCompactionAttempt(input: {
      id: string; executionId: string; attempt: number
      status: 'failed' | 'cancelled'; durationMs: number; usage: unknown; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ session_id: string }>(
          `SELECT session.id AS session_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await assertCurrentExecution(client, input.executionId)
        await insertCompactionAttempts(
          client, input.id, identity.rows[0].session_id, input.executionId, [{
            attempt: input.attempt, status: input.status,
            durationMs: input.durationMs, usage: input.usage,
          }], input.createdAt, true,
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async interruptActiveSessions(createdAt: string) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessions = await client.query<{
          id: string; execution_id: string; analysis_id: string; is_primary: boolean; latest_sequence: number
        }>(
          `SELECT session.id, execution.id AS execution_id, session.analysis_id,
                  session.is_primary, session.latest_sequence
           FROM agent_sessions session
           JOIN agent_executions execution ON execution.session_id = session.id
           WHERE execution.terminal = false
           ORDER BY session.id FOR UPDATE OF session, execution`,
        )
        const interrupted: Array<AgentEvent & { cancelledToolEvents: AgentEvent[] }> = []
        for (const session of sessions.rows) {
          const cancelled = await cancelRunningToolBatches(
            client, session.id, session.execution_id, session.latest_sequence, createdAt,
          )
          await finalizeRunningModelRequests(
            client, session.execution_id, 'outcome_unknown', createdAt,
          )
          const sequence = cancelled.latestSequence + 1
          const operationId = `startup:interrupt:${session.id}:${sequence}`
          const payload = {
            type: 'status', status: 'interrupted', terminal: true,
            previousExecutionId: session.execution_id, at: createdAt,
          }
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
            cancelledToolEvents: cancelled.events,
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
    async listByExecution(executionId: string, afterSequence: number): Promise<AgentEvent[]> {
      const result = await pool.query<AgentEventRow>(
        `SELECT event.session_id, event.sequence, event.operation_id, event.payload_json,
           event.created_at::text FROM agent_events event
         JOIN agent_executions execution ON execution.session_id = event.session_id
         WHERE execution.id = $1 AND event.sequence > $2 ORDER BY event.sequence`,
        [executionId, afterSequence],
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
    async sessionLifecycle(sessionId: string) {
      return readSessionLifecycle(pool, sessionId)
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
        const segments = await client.query<{
          id: string; ordinal: number; parent_segment_id: string | null; created_at: string
        }>(
          `SELECT id, ordinal, parent_segment_id, created_at::text FROM conversation_segments
           WHERE session_id = $1 ORDER BY ordinal`, [session.id],
        )
        const eventRows = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 ORDER BY sequence`, [session.id],
        )
        const compactions = await readCompactions(client, session.id)
        const compactionAttempts = await readCompactionAttempts(client, session.id)
        const { modelAttempts, tokenUsage } = await readModelUsage(client, session.id)
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
          parentSegmentId: segment.parent_segment_id,
          createdAt: new Date(segment.created_at).toISOString(),
          })),
          events: eventRows.rows.map(mapAgentEventRow).map((event) => ({
            sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
          })),
          compactions,
          compactionAttempts,
          modelAttempts,
          tokenUsage,
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

async function insertCompactionAttempts(
  client: PoolClient, compactionId: string, sessionId: string, executionId: string,
  attempts: Array<{
    attempt: number; status: 'completed' | 'failed' | 'cancelled'
    durationMs: number; usage: unknown
  }>, createdAt: string, compareCreatedAt = false,
) {
  for (const attempt of attempts) {
    const existing = await client.query<{
      session_id: string; execution_id: string; status: string; duration_ms: number
      usage_json: unknown; created_at: string
    }>(
      `SELECT session_id, execution_id, status, duration_ms, usage_json, created_at::text
       FROM agent_compaction_attempts WHERE compaction_id = $1 AND attempt = $2`,
      [compactionId, attempt.attempt],
    )
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.session_id !== sessionId || row.execution_id !== executionId
        || row.status !== attempt.status || row.duration_ms !== attempt.durationMs
        || !jsonValuesEqual(row.usage_json, attempt.usage)
        || (compareCreatedAt && !sameInstant(row.created_at, createdAt))) {
        throw new Error('agent_operation_conflict')
      }
      continue
    }
    await client.query(
      `INSERT INTO agent_compaction_attempts (
         compaction_id, session_id, execution_id, attempt, status, duration_ms, usage_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [compactionId, sessionId, executionId, attempt.attempt, attempt.status,
        attempt.durationMs, attempt.usage == null ? null : JSON.stringify(attempt.usage), createdAt],
    )
  }
}

async function readCompactions(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    id: string; from_segment_id: string; to_segment_id: string
    summary_json: Record<string, unknown>; usage_json: Record<string, unknown>
    created_at: string
  }>(
    `SELECT id, from_segment_id, to_segment_id, summary_json, usage_json, created_at::text
     FROM agent_compactions WHERE session_id = $1 ORDER BY created_at, id`, [sessionId],
  )
  const attempts = await client.query<{
    compaction_id: string; attempt: number; status: string; duration_ms: number
    usage_json: Record<string, unknown> | null
  }>(
    `SELECT compaction_id, attempt, status, duration_ms, usage_json
     FROM agent_compaction_attempts WHERE session_id = $1
     ORDER BY created_at, compaction_id, attempt`, [sessionId],
  )
  return result.rows.map((compaction) => ({
    id: compaction.id, fromSegmentId: compaction.from_segment_id,
    toSegmentId: compaction.to_segment_id, summary: compaction.summary_json,
    usage: compaction.usage_json,
    attempts: attempts.rows.filter(({ compaction_id }) => compaction_id === compaction.id)
      .map((attempt) => ({
        attempt: attempt.attempt, status: attempt.status,
        durationMs: attempt.duration_ms, usage: attempt.usage_json,
      })),
    createdAt: new Date(compaction.created_at).toISOString(),
  }))
}

async function readCompactionAttempts(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    compaction_id: string; attempt: number; status: string; duration_ms: number
    usage_json: Record<string, unknown> | null; created_at: string
  }>(
    `SELECT compaction_id, attempt, status, duration_ms, usage_json, created_at::text
     FROM agent_compaction_attempts WHERE session_id = $1
     ORDER BY created_at, compaction_id, attempt`, [sessionId],
  )
  return result.rows.map((attempt) => ({
    compactionId: attempt.compaction_id, attempt: attempt.attempt, status: attempt.status,
    durationMs: attempt.duration_ms, usage: attempt.usage_json,
    createdAt: new Date(attempt.created_at).toISOString(),
  }))
}

async function readModelUsage(client: PoolClient, sessionId: string) {
  const result = await client.query<{
    id: string; execution_id: string; turn_index: number; kind: string; status: string
    usage_status: string; input_tokens: number | null; cache_read_tokens: number | null
    cache_write_tokens: number | null; output_tokens: number | null; total_tokens: number | null
    created_at: string; completed_at: string | null
  }>(
    `SELECT request.id, request.execution_id, request.turn_index, request.kind, request.status,
       request.usage_status, request.input_tokens, request.cache_read_tokens,
       request.cache_write_tokens, request.output_tokens, request.total_tokens,
       request.created_at::text, request.completed_at::text
     FROM model_requests request
     JOIN agent_executions execution ON execution.id = request.execution_id
     WHERE execution.session_id = $1
     ORDER BY request.created_at, request.id`,
    [sessionId],
  )
  const modelAttempts = result.rows.map((row) => ({
    id: row.id, executionId: row.execution_id, kind: row.kind, turnIndex: row.turn_index,
    status: row.status, usageStatus: row.usage_status,
    usage: {
      input: row.input_tokens, cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens, output: row.output_tokens, total: row.total_tokens,
    },
    durationMs: row.completed_at === null
      ? null : Math.max(0, Date.parse(row.completed_at) - Date.parse(row.created_at)),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }))
  return {
    modelAttempts,
    tokenUsage: aggregateModelTokenUsage(modelAttempts),
  }
}

async function readSessionLifecycle(pool: Pool, sessionId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const sessionResult = await client.query<AgentSessionRow>(
      `SELECT id, analysis_id, is_primary, execution_id, status, latest_sequence,
              created_at::text, updated_at::text
       FROM agent_sessions WHERE id = $1`, [sessionId],
    )
    const sessionRow = sessionResult.rows[0]
    if (!sessionRow) { await client.query('COMMIT'); return null }
    const session = mapAgentSessionRow(sessionRow)
    const execution = await client.query<{
      id: string; generation: number; status: string; terminal: boolean
      wait_reason_json: Record<string, unknown> | null; created_at: string; updated_at: string
    }>(
      `SELECT id, generation, status, terminal, wait_reason_json,
              created_at::text, updated_at::text
       FROM agent_executions WHERE session_id = $1 ORDER BY generation DESC LIMIT 1`,
      [sessionId],
    )
    const segments = await client.query<{
      id: string; ordinal: number; parent_segment_id: string | null; created_at: string
    }>(
      `SELECT id, ordinal, parent_segment_id, created_at::text FROM conversation_segments
       WHERE session_id = $1 ORDER BY ordinal`, [sessionId],
    )
    const eventRows = await client.query<AgentEventRow>(
      `SELECT session_id, sequence, operation_id, payload_json, created_at::text
       FROM agent_events WHERE session_id = $1 ORDER BY sequence`, [sessionId],
    )
    const compactions = await readCompactions(client, sessionId)
    const compactionAttempts = await readCompactionAttempts(client, sessionId)
    const { modelAttempts, tokenUsage } = await readModelUsage(client, sessionId)
    const current = execution.rows[0]
    if (!current) { await client.query('COMMIT'); return null }
    const lifecycle = {
      ...session, status: current.status, waitReason: current.wait_reason_json,
      execution: {
        id: current.id, generation: current.generation, status: current.status,
        terminal: current.terminal, createdAt: new Date(current.created_at).toISOString(),
        updatedAt: new Date(current.updated_at).toISOString(),
      },
      segments: segments.rows.map((segment) => ({
        id: segment.id, ordinal: segment.ordinal,
        parentSegmentId: segment.parent_segment_id,
        createdAt: new Date(segment.created_at).toISOString(),
      })),
      events: eventRows.rows.map(mapAgentEventRow).map((event) => ({
        sequence: event.sequence, createdAt: event.createdAt, ...event.payload,
      })),
      compactions,
      compactionAttempts,
      modelAttempts,
      tokenUsage,
    }
    await client.query('COMMIT')
    return lifecycle
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

type ToolProjectionRow = {
  id: string; execution_id: string; version: number; role: string; stage: string
  schema_hash: string; projected_tools_json: unknown[]
  visible_tool_names_json: string[]; reasons_json: Record<string, unknown>
  created_at: string
}

export type ToolProjectionRole = 'main' | 'fundamental' | 'news' | 'technical'
export type ToolProjectionStage = 'research' | 'finalization'

export function createToolProjectionRepository(pool: Pool) {
  return {
    async ensureVersion(input: {
      executionId: string; role: ToolProjectionRole; stage: ToolProjectionStage; schemaHash: string
      projectedTools: unknown[]; visibleToolNames: string[]
      reasons: Record<string, unknown>; createdAt: string
      causativeEvent?: { operationId: string; payload: Record<string, unknown> }
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.executionId])
        const running = await client.query(
          `SELECT batch.id FROM tool_call_batches batch
           JOIN tool_projection_versions projection ON projection.id = batch.projection_id
           WHERE batch.execution_id = $1 AND projection.role = $2 AND batch.status = 'running' LIMIT 1`,
          [input.executionId, input.role],
        )
        if (running.rowCount) throw new Error('tool_batch_not_terminal')
        let causativeAgentEvent: AgentEvent | undefined
        if (input.causativeEvent) {
          const session = await client.query<{ id: string; latest_sequence: number }>(
            `SELECT session.id, session.latest_sequence FROM agent_executions execution
             JOIN agent_sessions session ON session.id = execution.session_id
             WHERE execution.id = $1 FOR UPDATE OF session`, [input.executionId],
          )
          if (!session.rows[0]) throw new Error('agent_session_not_found')
          const existingEvent = await client.query<AgentEventRow>(
            `SELECT session_id, sequence, operation_id, payload_json, created_at::text
             FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
            [session.rows[0].id, input.causativeEvent.operationId],
          )
          if (existingEvent.rows[0]) {
            if (!jsonValuesEqual(existingEvent.rows[0].payload_json, input.causativeEvent.payload)) {
              throw new Error('tool_projection_causative_event_conflict')
            }
          } else {
            const sequence = session.rows[0].latest_sequence + 1
            const insertedEvent = await client.query<AgentEventRow>(
              `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
              [session.rows[0].id, sequence, input.causativeEvent.operationId,
                JSON.stringify(input.causativeEvent.payload), input.createdAt],
            )
            await client.query(
              'UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3',
              [sequence, input.createdAt, session.rows[0].id],
            )
            causativeAgentEvent = mapAgentEventRow(insertedEvent.rows[0]!)
          }
        }
        const existing = await client.query<ToolProjectionRow>(
          `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json, visible_tool_names_json,
             reasons_json, created_at::text FROM tool_projection_versions
           WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
             AND visible_tool_names_json = $5::jsonb`,
          [input.executionId, input.role, input.stage, input.schemaHash,
            JSON.stringify(input.visibleToolNames)],
        )
        if (existing.rows[0]) {
          if (!jsonValuesEqual(existing.rows[0].projected_tools_json, input.projectedTools)
            || !jsonValuesEqual(existing.rows[0].reasons_json, input.reasons)) {
            throw new Error('tool_projection_conflict')
          }
          await client.query('COMMIT')
          return { ...mapToolProjection(existing.rows[0]), event: causativeAgentEvent }
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
        return { ...mapToolProjection(inserted.rows[0]!), event: causativeAgentEvent }
      } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    },
    async recordModelRequest(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number
      kind?: 'turn' | 'compaction'; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.id])
        const projection = await client.query(
          `SELECT id FROM tool_projection_versions WHERE id = $1 AND execution_id = $2`,
          [input.projectionId, input.executionId],
        )
        if (!projection.rowCount) throw new Error('tool_projection_not_available')
        const existing = await client.query<{
          execution_id: string; projection_id: string; turn_index: number
          kind: string; created_at: string
        }>(
          `SELECT execution_id, projection_id, turn_index, kind, created_at::text
           FROM model_requests WHERE id = $1`, [input.id],
        )
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (row.execution_id !== input.executionId || row.projection_id !== input.projectionId
            || row.turn_index !== input.turnIndex
            || row.kind !== (input.kind ?? 'turn')
            || new Date(row.created_at).toISOString() !== new Date(input.createdAt).toISOString()) {
            throw new Error('model_request_conflict')
          }
          await client.query('COMMIT')
          return
        }
        await client.query(
          `INSERT INTO model_requests (id, execution_id, projection_id, turn_index, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.id, input.executionId, input.projectionId, input.turnIndex,
            input.kind ?? 'turn', input.createdAt],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async completeModelRequest(input: {
      id: string; executionId: string
      status: 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'
      usageStatus: 'complete' | 'partial' | 'unknown'
      usage: {
        input: number | null; cacheRead: number | null; cacheWrite: number | null
        output: number | null; total: number | null
      }
      completedAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ analysis_id: string; session_id: string }>(
          `SELECT session.analysis_id, session.id AS session_id
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!identity.rows[0]) throw new Error('agent_execution_fenced')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
        )
        const execution = await client.query<{
          current_execution_id: string; terminal: boolean
        }>(
          `SELECT session.execution_id AS current_execution_id, execution.terminal
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 FOR UPDATE OF session, execution`, [input.executionId],
        )
        const request = await client.query<{
          execution_id: string; status: string; usage_status: string
          input_tokens: number | null; cache_read_tokens: number | null
          cache_write_tokens: number | null; output_tokens: number | null
          total_tokens: number | null; completed_at: string | null
        }>(
          `SELECT execution_id, status, usage_status, input_tokens, cache_read_tokens,
             cache_write_tokens, output_tokens, total_tokens, completed_at::text
           FROM model_requests WHERE id = $1 FOR UPDATE`, [input.id],
        )
        const row = request.rows[0]
        if (!row || row.execution_id !== input.executionId) throw new Error('model_request_not_found')
        if (row.status !== 'started') {
          if (row.status !== input.status || row.usage_status !== input.usageStatus
            || row.input_tokens !== input.usage.input
            || row.cache_read_tokens !== input.usage.cacheRead
            || row.cache_write_tokens !== input.usage.cacheWrite
            || row.output_tokens !== input.usage.output
            || row.total_tokens !== input.usage.total
            || !sameInstant(row.completed_at, input.completedAt)) {
            throw new Error('model_request_conflict')
          }
          await client.query('COMMIT')
          return { created: false }
        }
        if (execution.rows[0]?.current_execution_id !== input.executionId
          || execution.rows[0].terminal) throw new Error('agent_execution_fenced')
        await client.query(
          `UPDATE model_requests SET status = $1, usage_status = $2,
             input_tokens = $3, cache_read_tokens = $4, cache_write_tokens = $5,
             output_tokens = $6, total_tokens = $7, completed_at = $8
           WHERE id = $9`,
          [input.status, input.usageStatus, input.usage.input, input.usage.cacheRead,
            input.usage.cacheWrite, input.usage.output, input.usage.total,
            input.completedAt, input.id],
        )
        await client.query('COMMIT')
        return { created: true }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async beginToolBatch(input: {
      id: string; executionId: string; projectionId: string; turnIndex: number
      calls: Array<{
        toolCallId: string; toolName: string; position: number
        operationId?: string; eventPayload?: Record<string, unknown>
      }>; createdAt: string
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertCurrentExecution(client, input.executionId)
        const session = await client.query<{ id: string; latest_sequence: number }>(
          `SELECT session.id, session.latest_sequence FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 AND session.execution_id = execution.id AND NOT execution.terminal
           FOR UPDATE OF session, execution`, [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_execution_fenced')
        await client.query(
          `INSERT INTO tool_call_batches (
             id, execution_id, projection_id, turn_index, status, created_at
           ) VALUES ($1, $2, $3, $4, 'running', $5)`,
          [input.id, input.executionId, input.projectionId, input.turnIndex, input.createdAt],
        )
        const projected = await client.query<{ visible_tool_names_json: string[] }>(
          `SELECT visible_tool_names_json FROM tool_projection_versions
           WHERE id = $1 AND execution_id = $2`, [input.projectionId, input.executionId],
        )
        const visibleNames = new Set(projected.rows[0]?.visible_tool_names_json ?? [])
        for (const call of input.calls) {
          if (call.toolName !== 'tool_not_available' && !visibleNames.has(call.toolName)) {
            throw new Error('tool_not_available')
          }
          await client.query(
          `INSERT INTO tool_batch_calls (batch_id, tool_call_id, tool_name, position)
           VALUES ($1, $2, $3, $4)`,
          [input.id, call.toolCallId, call.toolName, call.position],
          )
        }
        let sequence = session.rows[0].latest_sequence
        for (const call of input.calls) {
          if (!call.operationId || !call.eventPayload) continue
          sequence += 1
          await client.query(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [session.rows[0].id, sequence, call.operationId,
              JSON.stringify(call.eventPayload), input.createdAt],
          )
        }
        if (sequence !== session.rows[0].latest_sequence) await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.createdAt, session.rows[0].id],
        )
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async startToolCall(input: {
      batchId: string; executionId: string; toolCallId: string; startedAt: string
      operationId: string; eventPayload: Record<string, unknown>
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          `SELECT session.analysis_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          id: string; latest_sequence: number; current_execution_id: string; terminal: boolean
        }>(
          `SELECT session.id, session.latest_sequence, session.execution_id AS current_execution_id,
             execution.terminal FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1
           FOR UPDATE OF session, execution`, [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        if (session.rows[0].current_execution_id !== input.executionId
          || session.rows[0].terminal) throw new Error('agent_execution_fenced')
        const call = await client.query<{ started_at: string | null; batch_status: string }>(
          `SELECT call.started_at::text, batch.status AS batch_status FROM tool_batch_calls call
           JOIN tool_call_batches batch ON batch.id = call.batch_id
           WHERE call.batch_id = $1 AND call.tool_call_id = $2
             AND batch.execution_id = $3
           FOR UPDATE OF call`, [input.batchId, input.toolCallId, input.executionId],
        )
        if (!call.rows[0]) throw new Error('tool_call_not_found')
        if (call.rows[0].batch_status !== 'running') throw new Error('tool_call_not_running')
        const eventPayload = { ...input.eventPayload, toolCallId: input.toolCallId }
        const existing = await client.query<AgentEventRow>(
          `SELECT session_id, sequence, operation_id, payload_json, created_at::text
           FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
          [session.rows[0].id, input.operationId],
        )
        if (call.rows[0].started_at || existing.rows[0]) {
          const row = existing.rows[0]
          if (!sameInstant(call.rows[0].started_at, input.startedAt) || !row
            || !sameInstant(row.created_at, input.startedAt)
            || !jsonValuesEqual(row.payload_json, eventPayload)) {
            throw new Error('tool_call_start_conflict')
          }
          await client.query('COMMIT')
          return mapAgentEventRow(row)
        }
        await client.query(
          `UPDATE tool_batch_calls SET started_at = $1
           WHERE batch_id = $2 AND tool_call_id = $3 AND status = 'running'`,
          [input.startedAt, input.batchId, input.toolCallId],
        )
        const sequence = session.rows[0].latest_sequence + 1
        const inserted = await client.query<AgentEventRow>(
          `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
          [session.rows[0].id, sequence, input.operationId,
            JSON.stringify(eventPayload), input.startedAt],
        )
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.startedAt, session.rows[0].id],
        )
        await client.query('COMMIT')
        return mapAgentEventRow(inserted.rows[0]!)
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
    async completeToolBatch(input: {
      id: string; executionId: string
      results: Array<{
        toolCallId: string; status: 'completed' | 'failed' | 'cancelled'
        startedAt: string | null; completedAt: string; completionOrder: number
        resultPayload: Record<string, unknown>; operationId: string
        eventPayload: Record<string, unknown>
      }>
      completedAt: string
      advance?: {
        role: ToolProjectionRole; stage: ToolProjectionStage; schemaHash: string
        projectedTools: unknown[]; visibleToolNames: string[]; reasons: Record<string, unknown>
        toolRounds: number; activeElapsedMs: number
        causativeEvent?: { operationId: string; payload: Record<string, unknown> }
      }
    }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const sessionIdentity = await client.query<{ analysis_id: string }>(
          `SELECT session.analysis_id FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1`, [input.executionId],
        )
        if (!sessionIdentity.rows[0]) throw new Error('agent_session_not_found')
        await client.query(
          'SELECT id FROM analyses WHERE id = $1 FOR UPDATE',
          [sessionIdentity.rows[0].analysis_id],
        )
        const session = await client.query<{
          session_id: string; analysis_id: string; latest_sequence: number
          current_execution_id: string; execution_terminal: boolean
        }>(
          `SELECT execution.session_id, session.analysis_id, session.latest_sequence,
             session.execution_id AS current_execution_id, execution.terminal AS execution_terminal
           FROM agent_executions execution
           JOIN agent_sessions session ON session.id = execution.session_id
           WHERE execution.id = $1 FOR UPDATE OF session, execution`,
          [input.executionId],
        )
        if (!session.rows[0]) throw new Error('agent_session_not_found')
        const batch = await client.query<{ status: string; completed_at: string | null }>(
          `SELECT status, completed_at::text FROM tool_call_batches
           WHERE id = $1 AND execution_id = $2 FOR UPDATE`,
          [input.id, input.executionId],
        )
        if (!batch.rows[0]) throw new Error('tool_batch_not_found')
        if (batch.rows[0].status === 'running'
          && (session.rows[0].current_execution_id !== input.executionId
            || session.rows[0].execution_terminal)) throw new Error('agent_execution_fenced')
        const expected = await client.query<{
          tool_call_id: string; status: string; started_at: string | null; completed_at: string | null
          completion_order: number | null; result_payload_json: Record<string, unknown> | null
        }>(
          `SELECT call.tool_call_id, call.status, call.started_at::text, call.completed_at::text,
             call.completion_order, call.result_payload_json
           FROM tool_batch_calls call
           WHERE call.batch_id = $1 ORDER BY call.position FOR UPDATE`,
          [input.id],
        )
        if (expected.rowCount !== input.results.length
          || new Set(input.results.map((result) => result.toolCallId)).size !== input.results.length
          || expected.rows.some((row) => !input.results.some((result) => result.toolCallId === row.tool_call_id))) {
          throw new Error('tool_batch_results_incomplete')
        }
        const orderedResults = [...input.results].sort((left, right) => left.completionOrder - right.completionOrder)
        if (orderedResults.some((result, index) => result.completionOrder !== index + 1)) {
          throw new Error('tool_batch_completion_order_invalid')
        }
        if (batch.rows[0].status !== 'running') {
          if (expected.rows.some((row) => row.result_payload_json === null || row.completion_order === null)) {
            throw new Error('agent_execution_fenced')
          }
          const expectedBatchStatus = input.results.some((result) => result.status === 'failed') ? 'failed'
            : input.results.some((result) => result.status === 'cancelled') ? 'cancelled' : 'completed'
          const callsMatch = expected.rows.every((row) => {
            const result = input.results.find((item) => item.toolCallId === row.tool_call_id)!
            return row.status === result.status
              && nullableInstantsEqual(row.started_at, result.startedAt)
              && sameInstant(row.completed_at, result.completedAt)
              && row.completion_order === result.completionOrder
              && jsonValuesEqual(row.result_payload_json, {
                ...result.resultPayload, toolCallId: result.toolCallId,
              })
          })
          if (!callsMatch || batch.rows[0].status !== expectedBatchStatus
            || !sameInstant(batch.rows[0].completed_at, input.completedAt)) {
            throw new Error('tool_batch_completion_conflict')
          }
          const existingEvents: AgentEvent[] = []
          for (const result of orderedResults) {
            const eventPayload: Record<string, unknown> = {
              ...result.eventPayload, toolCallId: result.toolCallId,
            }
            const event = await client.query<AgentEventRow>(
              `SELECT session_id, sequence, operation_id, payload_json, created_at::text
               FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
              [session.rows[0].session_id, result.operationId],
            )
            const row = event.rows[0]
            if (!row || !jsonValuesEqual(row.payload_json, eventPayload)
              || !sameInstant(row.created_at, result.completedAt)) {
              throw new Error('tool_batch_completion_conflict')
            }
            existingEvents.push(mapAgentEventRow(row))
          }
          if (input.advance) {
            const turnPayload = {
              type: 'runtime_turn_advanced', toolRounds: input.advance.toolRounds,
              activeElapsedMs: input.advance.activeElapsedMs, stage: input.advance.stage,
            }
            const advanceEvents = [
              { operationId: `${input.id}:turn-advanced`, payload: turnPayload },
              ...(input.advance.causativeEvent ? [input.advance.causativeEvent] : []),
            ]
            for (const expectedEvent of advanceEvents) {
              const event = await client.query<AgentEventRow>(
                `SELECT session_id, sequence, operation_id, payload_json, created_at::text
                 FROM agent_events WHERE session_id = $1 AND operation_id = $2`,
                [session.rows[0].session_id, expectedEvent.operationId],
              )
              if (!event.rows[0] || !jsonValuesEqual(event.rows[0].payload_json, expectedEvent.payload)) {
                throw new Error('tool_batch_completion_conflict')
              }
              existingEvents.push(mapAgentEventRow(event.rows[0]))
            }
          }
          const projection = input.advance ? await client.query<ToolProjectionRow>(
            `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json,
               visible_tool_names_json, reasons_json, created_at::text FROM tool_projection_versions
             WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
               AND visible_tool_names_json = $5::jsonb`,
            [input.executionId, input.advance.role, input.advance.stage, input.advance.schemaHash,
              JSON.stringify(input.advance.visibleToolNames)],
          ) : undefined
          if (input.advance && (!projection?.rows[0]
            || !jsonValuesEqual(projection.rows[0].projected_tools_json, input.advance.projectedTools)
            || !jsonValuesEqual(projection.rows[0].reasons_json, input.advance.reasons))) {
            throw new Error('tool_batch_completion_conflict')
          }
          existingEvents.sort((left, right) => left.sequence - right.sequence)
          await client.query('COMMIT')
          return { events: existingEvents, projection: projection?.rows[0]
            ? mapToolProjection(projection.rows[0]) : undefined }
        }
        for (const result of orderedResults) {
          const existingCall = expected.rows.find((row) => row.tool_call_id === result.toolCallId)!
          if (!nullableInstantsEqual(existingCall.started_at, result.startedAt)) {
            throw new Error('tool_batch_started_at_conflict')
          }
          if (result.startedAt === null && result.status !== 'cancelled') {
            throw new Error('tool_batch_started_at_required')
          }
          const updated = await client.query(
          `UPDATE tool_batch_calls SET status = $1, completed_at = $2,
             completion_order = $3, result_payload_json = $4
           WHERE batch_id = $5 AND tool_call_id = $6 AND status = 'running'`,
          [result.status, result.completedAt, result.completionOrder,
            JSON.stringify({ ...result.resultPayload, toolCallId: result.toolCallId }),
            input.id, result.toolCallId],
          )
          if (!updated.rowCount) throw new Error('tool_call_not_running')
        }
        const closed = await client.query(
          `UPDATE tool_call_batches batch SET
             status = CASE
               WHEN EXISTS (SELECT 1 FROM tool_batch_calls call
                 WHERE call.batch_id = batch.id AND call.status = 'failed') THEN 'failed'
               WHEN EXISTS (SELECT 1 FROM tool_batch_calls call
                 WHERE call.batch_id = batch.id AND call.status = 'cancelled') THEN 'cancelled'
               ELSE 'completed'
             END,
             completed_at = $1
           WHERE id = $2 AND execution_id = $3 AND status = 'running'`,
          [input.completedAt, input.id, input.executionId],
        )
        if (!closed.rowCount) throw new Error('tool_batch_not_running')
        const createdEvents: AgentEvent[] = []
        let sequence = session.rows[0].latest_sequence
        for (const result of orderedResults) {
          const eventPayload: Record<string, unknown> = {
            ...result.eventPayload, toolCallId: result.toolCallId,
          }
          sequence += 1
          const inserted = await client.query<AgentEventRow>(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
            [session.rows[0].session_id, sequence, result.operationId,
              JSON.stringify(eventPayload), result.completedAt],
          )
          createdEvents.push(mapAgentEventRow(inserted.rows[0]!))
          if (eventPayload.type === 'tool_result') {
            const facts = (eventPayload.result as { facts?: unknown[] } | undefined)?.facts ?? []
            for (const fact of facts) {
              if (!fact || typeof fact !== 'object' || typeof (fact as { id?: unknown }).id !== 'string') continue
              const id = (fact as { id: string }).id
              await client.query(
                `INSERT INTO atomic_facts (id, payload_json, is_public) VALUES ($1, $2, true)
                 ON CONFLICT (id) DO NOTHING`,
                [id, JSON.stringify(fact)],
              )
              await client.query(
                `INSERT INTO analysis_facts (analysis_id, fact_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [session.rows[0].analysis_id, id],
              )
            }
          }
        }
        let advancedProjection: ReturnType<typeof mapToolProjection> | undefined
        if (input.advance) {
          sequence += 1
          const turnEvent = await client.query<AgentEventRow>(
            `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
            [session.rows[0].session_id, sequence, `${input.id}:turn-advanced`, JSON.stringify({
              type: 'runtime_turn_advanced', toolRounds: input.advance.toolRounds,
              activeElapsedMs: input.advance.activeElapsedMs, stage: input.advance.stage,
            }), input.completedAt],
          )
          createdEvents.push(mapAgentEventRow(turnEvent.rows[0]!))
          if (input.advance.causativeEvent) {
            sequence += 1
            const decision = await client.query<AgentEventRow>(
              `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
              [session.rows[0].session_id, sequence, input.advance.causativeEvent.operationId,
                JSON.stringify(input.advance.causativeEvent.payload), input.completedAt],
            )
            createdEvents.push(mapAgentEventRow(decision.rows[0]!))
          }
          const existingProjection = await client.query<ToolProjectionRow>(
            `SELECT id, execution_id, version, role, stage, schema_hash, projected_tools_json,
               visible_tool_names_json, reasons_json, created_at::text FROM tool_projection_versions
             WHERE execution_id = $1 AND role = $2 AND stage = $3 AND schema_hash = $4
               AND visible_tool_names_json = $5::jsonb`,
            [input.executionId, input.advance.role, input.advance.stage, input.advance.schemaHash,
              JSON.stringify(input.advance.visibleToolNames)],
          )
          if (existingProjection.rows[0]) {
            if (!jsonValuesEqual(existingProjection.rows[0].projected_tools_json, input.advance.projectedTools)
              || !jsonValuesEqual(existingProjection.rows[0].reasons_json, input.advance.reasons)) {
              throw new Error('tool_projection_conflict')
            }
            advancedProjection = mapToolProjection(existingProjection.rows[0])
          } else {
            const version = Number((await client.query<{ next: number }>(
              `SELECT COALESCE(max(version), 0) + 1 AS next
               FROM tool_projection_versions WHERE execution_id = $1`, [input.executionId],
            )).rows[0]!.next)
            const insertedProjection = await client.query<ToolProjectionRow>(
              `INSERT INTO tool_projection_versions (
                 id, execution_id, version, role, stage, schema_hash, projected_tools_json,
                 visible_tool_names_json, reasons_json, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               RETURNING id, execution_id, version, role, stage, schema_hash, projected_tools_json,
                 visible_tool_names_json, reasons_json, created_at::text`,
              [`${input.executionId}:tool-projection:${version}`, input.executionId, version,
                input.advance.role, input.advance.stage, input.advance.schemaHash,
                JSON.stringify(input.advance.projectedTools), JSON.stringify(input.advance.visibleToolNames),
                JSON.stringify(input.advance.reasons), input.completedAt],
            )
            advancedProjection = mapToolProjection(insertedProjection.rows[0]!)
          }
        }
        await client.query(
          `UPDATE agent_sessions SET latest_sequence = $1, updated_at = $2 WHERE id = $3`,
          [sequence, input.completedAt, session.rows[0].session_id],
        )
        await client.query('COMMIT')
        return { events: createdEvents, projection: advancedProjection }
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
           WHERE request.execution_id = $1
           ORDER BY request.turn_index, request.created_at, request.id`, [executionId],
        ),
        pool.query<{ id: string; projection_version: number; turn_index: number; status: string; created_at: string; completed_at: string | null }>(
          `SELECT batch.id, projection.version AS projection_version, batch.turn_index,
             batch.status, batch.created_at::text, batch.completed_at::text
           FROM tool_call_batches batch
           JOIN tool_projection_versions projection ON projection.id = batch.projection_id
           WHERE batch.execution_id = $1
           ORDER BY batch.turn_index, batch.created_at, batch.id`, [executionId],
        ),
        pool.query<{
          batch_id: string; tool_call_id: string; tool_name: string; position: number; status: string
          started_at: string | null; completed_at: string | null; completion_order: number | null
          result_payload_json: Record<string, unknown> | null
        }>(
          `SELECT call.batch_id, call.tool_call_id, call.tool_name, call.position, call.status,
             call.started_at::text, call.completed_at::text, call.completion_order,
             call.result_payload_json FROM tool_batch_calls call
           JOIN tool_call_batches batch ON batch.id = call.batch_id
           WHERE batch.execution_id = $1
           ORDER BY batch.turn_index, batch.created_at, batch.id, call.position`, [executionId],
        ),
      ])
      return {
        projections: projections.rows.map(mapToolProjection),
        modelRequests: requests.rows.map((row) => ({
          id: row.id, projectionVersion: row.projection_version, turnIndex: row.turn_index,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        toolBatches: batches.rows.map((batch) => ({
          id: batch.id, projectionVersion: batch.projection_version,
          turnIndex: batch.turn_index, status: batch.status,
          calls: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, toolName: call.tool_name, position: call.position,
          })),
          results: calls.rows.filter((call) => call.batch_id === batch.id).map((call) => ({
            toolCallId: call.tool_call_id, status: call.status,
            startedAt: call.started_at ? new Date(call.started_at).toISOString() : null,
            completedAt: call.completed_at ? new Date(call.completed_at).toISOString() : null,
            completionOrder: call.completion_order, resultPayload: call.result_payload_json,
          })),
        })),
      }
    },
    async replayForSession(sessionId: string, executionId: string) {
      const belongs = await pool.query(
        `SELECT id FROM agent_executions WHERE id = $1 AND session_id = $2`,
        [executionId, sessionId],
      )
      if (!belongs.rowCount) return null
      return { executionId, ...await this.replay(executionId) }
    },
  }
}

export type ToolProjectionRepository = ReturnType<typeof createToolProjectionRepository>

async function cancelRunningToolBatches(
  database: PoolClient, sessionId: string, executionId: string,
  latestSequence: number, completedAt: string,
) {
  const calls = await database.query<{
    batch_id: string; tool_call_id: string; tool_name: string; position: number; started_at: string | null
    max_completion_order: number
  }>(
    `SELECT call.batch_id, call.tool_call_id, call.tool_name, call.position, call.started_at::text,
       COALESCE((SELECT max(completed.completion_order) FROM tool_batch_calls completed
         WHERE completed.batch_id = call.batch_id), 0)::integer AS max_completion_order
    FROM tool_batch_calls call
    JOIN tool_call_batches batch ON batch.id = call.batch_id
    JOIN tool_projection_versions projection ON projection.id = batch.projection_id
     WHERE batch.execution_id = $1 AND batch.status = 'running' AND call.status = 'running'
       AND (projection.visible_tool_names_json ? call.tool_name OR call.tool_name = 'tool_not_available')
     ORDER BY call.batch_id, call.position FOR UPDATE OF call`, [executionId],
  )
  const orderByBatch = new Map<string, number>()
  const events: AgentEvent[] = []
  let sequence = latestSequence
  for (const call of calls.rows) {
    const completionOrder = (orderByBatch.get(call.batch_id) ?? call.max_completion_order) + 1
    orderByBatch.set(call.batch_id, completionOrder)
    await database.query(
      `UPDATE tool_batch_calls SET status = 'cancelled', completed_at = $1,
         completion_order = $2, result_payload_json = $3
       WHERE batch_id = $4 AND tool_call_id = $5 AND status = 'running'`,
      [completedAt, completionOrder, JSON.stringify({
        toolCallId: call.tool_call_id,
        toolName: call.tool_name,
        result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      }), call.batch_id, call.tool_call_id],
    )
    const startedAt = call.started_at
    if (startedAt === null) {
      sequence += 1
      const callOperationId = `${call.batch_id}:cancelled-call:${call.tool_call_id}`
      const callPayload = {
        type: 'tool_call', name: call.tool_name, toolCallId: call.tool_call_id,
        input: {}, startedAt: null, notStarted: true, operationId: callOperationId,
      }
      const insertedCall = await database.query<AgentEventRow>(
        `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
        [sessionId, sequence, callOperationId, JSON.stringify(callPayload), completedAt],
      )
      events.push(mapAgentEventRow(insertedCall.rows[0]!))
    }
    sequence += 1
    const operationId = `${call.batch_id}:cancelled-result:${call.tool_call_id}`
    const payload = {
      type: 'tool_result', name: call.tool_name,
      result: { error: 'tool_execution_interrupted', facts: [] }, isError: true,
      toolCallId: call.tool_call_id, startedAt, notStarted: startedAt === null,
      completedAt, completionOrder, operationId,
    }
    const inserted = await database.query<AgentEventRow>(
      `INSERT INTO agent_events (session_id, sequence, operation_id, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING session_id, sequence, operation_id, payload_json, created_at::text`,
      [sessionId, sequence, operationId, JSON.stringify(payload), completedAt],
    )
    events.push(mapAgentEventRow(inserted.rows[0]!))
  }
  await database.query(
    `UPDATE tool_call_batches SET status = 'cancelled', completed_at = $1
     WHERE execution_id = $2 AND status = 'running'`,
    [completedAt, executionId],
  )
  return { latestSequence: sequence, events }
}

async function cancelRunningCompactionAttempts(
  database: PoolClient, sessionId: string, executionId: string, cancelledAt: string,
) {
  const requests = await database.query<{
    id: string; created_at: string; attempt: number; compaction_id: string
  }>(
    `SELECT request.id, request.created_at::text,
       (regexp_match(request.id, ':compaction:[^:]+:attempt:([12])$'))[1]::integer AS attempt,
       regexp_replace(request.id, ':attempt:[12]$', '') AS compaction_id
     FROM model_requests request
     WHERE request.execution_id = $1 AND request.id ~ ':compaction:[^:]+:attempt:[12]$'
       AND NOT EXISTS (
         SELECT 1 FROM agent_compaction_attempts attempt
         WHERE attempt.compaction_id = regexp_replace(request.id, ':attempt:[12]$', '')
           AND attempt.attempt = (regexp_match(request.id, ':compaction:[^:]+:attempt:([12])$'))[1]::integer
       )
     ORDER BY request.created_at, request.id`,
    [executionId],
  )
  for (const request of requests.rows) {
    await insertCompactionAttempts(
      database, request.compaction_id, sessionId, executionId, [{
        attempt: request.attempt, status: 'cancelled',
        durationMs: Math.max(0, Date.parse(cancelledAt) - Date.parse(request.created_at)),
        usage: null,
      }], cancelledAt,
    )
  }
}

async function finalizeRunningModelRequests(
  database: PoolClient, executionId: string,
  status: 'cancelled' | 'outcome_unknown', completedAt: string,
) {
  await database.query(
    `UPDATE model_requests SET status = $1, usage_status = 'unknown', completed_at = $2
     WHERE execution_id = $3 AND status = 'started'`,
    [status, completedAt, executionId],
  )
}

async function assertCurrentExecution(database: PoolClient, executionId: string) {
  const identity = await database.query<{ analysis_id: string }>(
    `SELECT session.analysis_id FROM agent_executions execution
     JOIN agent_sessions session ON session.id = execution.session_id
     WHERE execution.id = $1`, [executionId],
  )
  if (!identity.rows[0]) throw new Error('agent_execution_fenced')
  await database.query(
    'SELECT id FROM analyses WHERE id = $1 FOR UPDATE', [identity.rows[0].analysis_id],
  )
  const execution = await database.query(
    `SELECT execution.id FROM agent_executions execution
     JOIN agent_sessions session ON session.id = execution.session_id
     WHERE execution.id = $1 AND session.execution_id = execution.id AND NOT execution.terminal
     FOR UPDATE OF session, execution`, [executionId],
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

function jsonValuesEqual(left: unknown, right: unknown) {
  return canonicalizeJson(left) === canonicalizeJson(right)
}

function nullableInstantsEqual(left: string | null, right: string | null) {
  return left === null || right === null ? left === right : sameInstant(left, right)
}

function sameInstant(left: string | null, right: string) {
  return left !== null && new Date(left).getTime() === new Date(right).getTime()
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
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
