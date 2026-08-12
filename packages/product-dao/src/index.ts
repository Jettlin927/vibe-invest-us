import { Pool } from 'pg'

export const schemaVersion = 1

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

INSERT INTO product_schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vibe_invest_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vibe_invest_app;
GRANT SELECT ON product_schema_migrations TO vibe_invest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON positions, portfolio_settings, portfolio_equity_snapshots TO vibe_invest_app;
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
