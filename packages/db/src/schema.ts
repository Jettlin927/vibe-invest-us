import { researchSourceMigrationSql } from './research-library.js'
import { workbenchMigrationSql } from './workbench.js'
import { Pool } from 'pg'
import { defaultRuntimeSettings } from '@vibe-invest/contracts'

export const schemaVersion = 32

const migrationSql = `
${workbenchMigrationSql}
CREATE TABLE IF NOT EXISTS portfolio_trade_operations (
  operation_id text PRIMARY KEY,
  payload_json jsonb NOT NULL,
  result_json jsonb NOT NULL
);

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

-- 修正旧版新建库的文本定义，使其与已有时间列保持一致；无效值会使迁移回滚。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'portfolio_equity_snapshots'
      AND column_name = 'observed_at' AND data_type = 'text') THEN
    ALTER TABLE portfolio_equity_snapshots DROP CONSTRAINT IF EXISTS portfolio_equity_snapshots_observed_at_check;
    ALTER TABLE portfolio_equity_snapshots ALTER COLUMN observed_at TYPE timestamptz USING observed_at::timestamptz;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS portfolio_events (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('buy', 'sell', 'cash_adjust', 'reconcile')),
  symbol text,
  quantity numeric,
  price numeric,
  amount numeric,
  realized_pnl numeric,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS profit_protection_plan_versions (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  anchor_price numeric NOT NULL CHECK (anchor_price > 0),
  invalidation_price numeric NOT NULL CHECK (invalidation_price >= 0),
  core_ratio numeric NOT NULL CHECK (core_ratio > 0 AND core_ratio < 1),
  max_portfolio_weight numeric NOT NULL CHECK (max_portfolio_weight > 0 AND max_portfolio_weight <= 1),
  planned_quantity numeric NOT NULL CHECK (planned_quantity > 0),
  planned_average_cost numeric NOT NULL CHECK (planned_average_cost >= 0),
  earnings_date date,
  earnings_risk_starts_at date,
  created_at timestamptz NOT NULL,
  UNIQUE (symbol, revision),
  CHECK (invalidation_price < anchor_price)
);

ALTER TABLE profit_protection_plan_versions ADD COLUMN IF NOT EXISTS earnings_date date;
ALTER TABLE profit_protection_plan_versions ADD COLUMN IF NOT EXISTS earnings_risk_starts_at date;

CREATE TABLE IF NOT EXISTS profit_protection_states (
  symbol text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES profit_protection_plan_versions(id),
  peak_price numeric NOT NULL CHECK (peak_price >= 0),
  last_price numeric NOT NULL CHECK (last_price >= 0),
  ema_20 numeric,
  observed_at text NOT NULL CHECK (observed_at <> ''),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS profit_protection_triggers (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  symbol text NOT NULL,
  plan_id text NOT NULL REFERENCES profit_protection_plan_versions(id),
  rule text NOT NULL CHECK (rule <> ''),
  status text NOT NULL CHECK (status IN ('open', 'acknowledged')),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  triggered_at timestamptz NOT NULL,
  acknowledged_at timestamptz
);

CREATE TABLE IF NOT EXISTS legacy_portfolio_migrations (
  source_sha256 text PRIMARY KEY,
  source_path text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id text PRIMARY KEY,
  symbol text,
  kind text NOT NULL DEFAULT 'research' CHECK (kind IN ('research', 'conversation')),
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

CREATE TABLE IF NOT EXISTS analysis_deletion_tombstones (
  analysis_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL
);

ALTER TABLE analyses ADD COLUMN IF NOT EXISTS report_created_at timestamptz;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'research';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS parent_id text REFERENCES analyses(id) ON DELETE CASCADE;
ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_kind_check;
ALTER TABLE analyses ADD CONSTRAINT analyses_kind_check
  CHECK (kind IN ('research', 'conversation'));
ALTER TABLE analyses ALTER COLUMN symbol DROP NOT NULL;

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
  snapshot_json jsonb,
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

CREATE TABLE IF NOT EXISTS watchlist_items (
  symbol text PRIMARY KEY CHECK (symbol <> '' AND symbol = upper(symbol)),
  note text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS tracking_runs (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  targets_json jsonb NOT NULL CHECK (jsonb_typeof(targets_json) = 'array'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error text,
  CONSTRAINT tracking_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL AND error IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_runs_one_active
  ON tracking_runs ((true)) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS tracking_observations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES tracking_runs(id),
  symbol text NOT NULL CHECK (symbol <> '' AND symbol = upper(symbol)),
  capability text NOT NULL CHECK (capability IN ('technical', 'fundamental', 'news')),
  status text NOT NULL CHECK (status IN ('success', 'data_gap')),
  baseline_observation_id text REFERENCES tracking_observations(id),
  observed_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  UNIQUE (run_id, symbol, capability)
);
CREATE INDEX IF NOT EXISTS tracking_observations_success_baseline
  ON tracking_observations (symbol, capability, observed_at DESC, id DESC)
  WHERE status = 'success';

CREATE TABLE IF NOT EXISTS tracking_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES tracking_runs(id),
  observation_id text NOT NULL REFERENCES tracking_observations(id),
  baseline_observation_id text NOT NULL REFERENCES tracking_observations(id),
  event_key text NOT NULL UNIQUE CHECK (event_key <> ''),
  symbol text NOT NULL CHECK (symbol <> '' AND symbol = upper(symbol)),
  capability text NOT NULL CHECK (capability IN ('technical', 'fundamental', 'news')),
  kind text NOT NULL CHECK (kind <> ''),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  occurred_at text NOT NULL CHECK (occurred_at <> ''),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tracking_events_timeline
  ON tracking_events (occurred_at DESC, id DESC);

ALTER TABLE tracking_observations
  ALTER COLUMN observed_at TYPE text USING observed_at::text;
ALTER TABLE tracking_observations DROP CONSTRAINT IF EXISTS tracking_observations_observed_at_check;
ALTER TABLE tracking_observations ADD CONSTRAINT tracking_observations_observed_at_check
  CHECK (observed_at <> '');
ALTER TABLE tracking_events
  ALTER COLUMN occurred_at TYPE text USING occurred_at::text;
ALTER TABLE tracking_events DROP CONSTRAINT IF EXISTS tracking_events_occurred_at_check;
ALTER TABLE tracking_events ADD CONSTRAINT tracking_events_occurred_at_check
  CHECK (occurred_at <> '');

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
  FROM analyses WHERE active AND kind = 'research' AND symbol IS NOT NULL
)
UPDATE analyses SET status = 'interrupted', active = false, updated_at = now()
FROM duplicate_active
WHERE analyses.id = duplicate_active.id AND duplicate_active.position > 1;

DROP INDEX IF EXISTS analyses_one_active_per_symbol;
CREATE UNIQUE INDEX analyses_one_active_per_symbol
  ON analyses (symbol) WHERE active AND kind = 'research' AND symbol IS NOT NULL;

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

ALTER TABLE report_versions ADD COLUMN IF NOT EXISTS snapshot_json jsonb;

UPDATE report_versions AS report
SET snapshot_json = analysis.snapshot_json
FROM analyses AS analysis
WHERE report.analysis_id = analysis.id
  AND report.kind = 'integrated'
  AND report.snapshot_json IS NULL
  AND analysis.snapshot_json IS NOT NULL
  AND report.version = (
    SELECT max(candidate.version) FROM report_versions AS candidate
    WHERE candidate.session_id = report.session_id AND candidate.kind = 'integrated'
  );

INSERT INTO product_schema_migrations (version)
VALUES (23)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (24)
ON CONFLICT (version) DO NOTHING;

INSERT INTO portfolio_events (id, kind, symbol, quantity, price, note, created_at)
SELECT 'opening:position:' || symbol, 'reconcile', symbol, quantity, average_cost,
       '期初建仓：迁移自手工快照持仓', updated_at
FROM positions
ON CONFLICT (id) DO NOTHING;

INSERT INTO portfolio_events (id, kind, amount, note, created_at)
SELECT 'opening:cash', 'cash_adjust', cash, '期初入金：迁移自手工维护现金', updated_at
FROM portfolio_settings
WHERE id = 1 AND cash > 0
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (25)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (26)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (27)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (28)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (29)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (30)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version)
VALUES (31)
ON CONFLICT (version) DO NOTHING;

INSERT INTO product_schema_migrations (version) VALUES (32) ON CONFLICT (version) DO NOTHING;

${researchSourceMigrationSql}

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vibe_invest_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON research_source_links TO vibe_invest_app;
GRANT SELECT, INSERT ON workbench_versions, workbench_operations, portfolio_trade_operations TO vibe_invest_app;
GRANT SELECT ON product_schema_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON positions, portfolio_settings, portfolio_equity_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON portfolio_events TO vibe_invest_app;
GRANT SELECT, INSERT ON profit_protection_plan_versions TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON profit_protection_states TO vibe_invest_app;
GRANT SELECT, INSERT ON profit_protection_triggers TO vibe_invest_app;
GRANT UPDATE (status, acknowledged_at) ON profit_protection_triggers TO vibe_invest_app;
GRANT SELECT, INSERT ON legacy_portfolio_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analyses, atomic_facts, analysis_facts, analysis_trace TO vibe_invest_app;
GRANT SELECT, INSERT ON analysis_deletion_tombstones TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON agent_sessions TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_events TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE ON agent_executions TO vibe_invest_app;
GRANT SELECT, INSERT ON conversation_segments TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_compactions TO vibe_invest_app;
GRANT SELECT, INSERT ON agent_compaction_attempts TO vibe_invest_app;
GRANT SELECT, INSERT ON runtime_settings_revisions TO vibe_invest_app;
GRANT SELECT, INSERT, DELETE ON execution_settings_snapshots TO vibe_invest_app;
GRANT SELECT, INSERT ON tool_projection_versions, model_requests, tool_call_batches, tool_batch_calls TO vibe_invest_app;
GRANT UPDATE (
  status, usage_status, input_tokens, cache_read_tokens, cache_write_tokens,
  output_tokens, total_tokens, completed_at
) ON model_requests TO vibe_invest_app;
GRANT SELECT, INSERT ON report_versions TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlist_items TO vibe_invest_app;
GRANT SELECT, INSERT ON tracking_runs TO vibe_invest_app;
GRANT UPDATE (status, completed_at, error) ON tracking_runs TO vibe_invest_app;
GRANT SELECT, INSERT ON tracking_observations, tracking_events TO vibe_invest_app;
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
