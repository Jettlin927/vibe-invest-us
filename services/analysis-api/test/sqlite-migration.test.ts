import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createAgentEventRepository, createAnalysisRepository, createPool, createRuntimeSettingsRepository, migrate } from '@vibe-invest/product-dao'

import { buildApp } from '../src/app.js'
import { executeMigration, planMigration, verifyMigration } from '../src/sqlite-migration.js'
import { checkSchema, createPortfolioRepository } from '@vibe-invest/product-dao'

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL
const databaseUrl = process.env.TEST_DATABASE_URL
const verificationToken = 'test-migration-verification-token'

function createLegacyFixture(path: string) {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE positions (symbol TEXT PRIMARY KEY, quantity REAL NOT NULL, average_cost REAL NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portfolio_settings (id INTEGER PRIMARY KEY, cash REAL NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portfolio_equity_snapshots (market_day TEXT PRIMARY KEY, total_equity REAL NOT NULL, total_market_value REAL NOT NULL, cash REAL NOT NULL, holdings_count INTEGER NOT NULL, priced_count INTEGER NOT NULL, observed_at TEXT NOT NULL, after_close INTEGER NOT NULL);
    CREATE TABLE analyses (id TEXT PRIMARY KEY, snapshot_json TEXT, report_json TEXT);
    CREATE TABLE atomic_facts (id TEXT PRIMARY KEY);
    CREATE TABLE analysis_trace (id INTEGER PRIMARY KEY);
    INSERT INTO positions VALUES ('NVDA', 10.125, 100.25, '2026-08-12T00:00:00.000Z');
    INSERT INTO portfolio_settings VALUES (1, 500.5, '2026-08-12T00:00:00.000Z');
    INSERT INTO portfolio_equity_snapshots VALUES ('2026-08-12', 1715.5, 1215, 500.5, 1, 1, '2026-08-12T20:05:00.000Z', 1);
    INSERT INTO analyses VALUES ('legacy-analysis', '{}', '{}');
    INSERT INTO atomic_facts VALUES ('legacy-fact');
    INSERT INTO analysis_trace VALUES (1);
  `)
  database.close()
}

test('SQLite 迁移按 plan→execute→verify 导入且明确放弃旧研究', {
  skip: !migrationUrl || !databaseUrl,
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-sqlite-migration-'))
  const source = join(directory, 'legacy.db')
  createLegacyFixture(source)
  await migrate(migrationUrl!)
  const cleanupPool = createPool(migrationUrl!)
  await cleanupPool.query('DELETE FROM portfolio_equity_snapshots')
  await cleanupPool.query('DELETE FROM positions')
  await cleanupPool.query('UPDATE portfolio_settings SET cash = 0 WHERE id = 1')
  await cleanupPool.query('DELETE FROM legacy_portfolio_migrations')
  await cleanupPool.end()

  assert.deepEqual(await planMigration(source), {
    source,
    migrate: { positions: 1, cash: 1, equitySnapshots: 1 },
    abandon: { research: 1, reports: 1, analysisSnapshots: 1, facts: 1, traces: 1 },
  })
  await executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'http://127.0.0.1:1/api/health' })
  await assert.rejects(
    executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'http://127.0.0.1:1/api/health' }),
    /legacy_migration_already_executed/,
  )
  const apiPool = createPool(databaseUrl!)
  const api = buildApp({
    productDatabase: { checkSchema: () => checkSchema(apiPool), close: () => apiPool.end() },
    portfolioRepository: createPortfolioRepository(apiPool),
    analysisRepository: createAnalysisRepository(apiPool),
    agentEventRepository: createAgentEventRepository(apiPool),
    runtimeSettingsRepository: createRuntimeSettingsRepository(apiPool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    migrationVerificationToken: verificationToken,
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  const address = api.server.address()
  assert.ok(address && typeof address === 'object')
  const verified = await verifyMigration({
    source,
    databaseUrl: databaseUrl!,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    apiToken: verificationToken,
  })
  assert.deepEqual(verified, { positions: 1, cash: true, equitySnapshots: 1, database: 'verified' })
  await api.close()
})

test('SQLite verify 会拒绝 Analysis API 返回的权益金额不一致', {
  skip: !migrationUrl || !databaseUrl,
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-sqlite-api-verify-'))
  const source = join(directory, 'legacy.db')
  createLegacyFixture(source)
  await migrate(migrationUrl!)
  const pool = createPool(migrationUrl!)
  await pool.query('DELETE FROM legacy_portfolio_migrations')
  await pool.query('DELETE FROM portfolio_equity_snapshots')
  await pool.query('DELETE FROM positions')
  await pool.query('UPDATE portfolio_settings SET cash = 0 WHERE id = 1')
  await pool.end()
  await executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'http://127.0.0.1:1/api/health' })

  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      positions: [{ symbol: 'NVDA', quantity: '10.125', averageCost: '100.25' }],
      cash: '500.5',
      snapshots: [{ marketDay: '2026-08-12', totalEquity: '1715.5001', totalMarketValue: '1215', cash: '500.5' }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await assert.rejects(
    verifyMigration({
      source, databaseUrl: databaseUrl!, apiBaseUrl: `http://127.0.0.1:${address.port}`,
      apiToken: verificationToken,
    }),
    /legacy_migration_api_verification_failed/,
  )
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('SQLite 迁移拒绝 API 运行、目标冲突和验证不一致', {
  skip: !migrationUrl || !databaseUrl,
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-sqlite-migration-errors-'))
  const source = join(directory, 'legacy.db')
  createLegacyFixture(source)
  await assert.rejects(
    executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'data:application/json,{}' }),
    /api_must_be_stopped/,
  )
  const cleanupPool = createPool(migrationUrl!)
  await cleanupPool.query('DELETE FROM legacy_portfolio_migrations')
  await cleanupPool.query('DELETE FROM positions')
  await cleanupPool.query(
    `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
     VALUES ($1, $2, $3, $4)`, ['CONFLICT', '1', '1', '2026-08-12T00:00:00Z'],
  )
  await cleanupPool.end()
  await assert.rejects(
    executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'http://127.0.0.1:1/api/health' }),
    /legacy_migration_target_conflict/,
  )
  const verifyPool = createPool(migrationUrl!)
  await verifyPool.query('DELETE FROM positions')
  await verifyPool.query(
    `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
     VALUES ($1, $2, $3, $4)`, ['NVDA', '99', '100.25', '2026-08-12T00:00:00Z'],
  )
  await verifyPool.end()
  await assert.rejects(verifyMigration({
    source, databaseUrl: databaseUrl!, apiBaseUrl: 'http://127.0.0.1:1', apiToken: verificationToken,
  }), /legacy_migration_verification_failed/)
})

test('SQLite 迁移中途失败会回滚目标且保留源文件', {
  skip: !migrationUrl || !databaseUrl,
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-sqlite-migration-rollback-'))
  const source = join(directory, 'legacy.db')
  createLegacyFixture(source)
  const sqlite = new DatabaseSync(source)
  sqlite.prepare('UPDATE portfolio_settings SET updated_at = ? WHERE id = 1').run('not-a-timestamp')
  sqlite.close()
  const cleanupPool = createPool(migrationUrl!)
  await cleanupPool.query('DELETE FROM legacy_portfolio_migrations')
  await cleanupPool.query('DELETE FROM portfolio_equity_snapshots')
  await cleanupPool.query('DELETE FROM positions')
  await cleanupPool.query('UPDATE portfolio_settings SET cash = 0, updated_at = now() WHERE id = 1')
  await cleanupPool.end()

  await assert.rejects(
    executeMigration({ source, databaseUrl: databaseUrl!, apiHealthUrl: 'http://127.0.0.1:1/api/health' }),
    /date\/time field value out of range|invalid input syntax for type timestamp/,
  )
  const verifyPool = createPool(migrationUrl!)
  const target = await verifyPool.query<{ positions: number; receipts: number; cash: string }>(
    `SELECT (SELECT count(*)::integer FROM positions) AS positions,
            (SELECT count(*)::integer FROM legacy_portfolio_migrations) AS receipts,
            (SELECT cash::text FROM portfolio_settings WHERE id = 1) AS cash`,
  )
  assert.deepEqual(target.rows, [{ positions: 0, receipts: 0, cash: '0' }])
  await verifyPool.end()
  assert.equal((await planMigration(source)).migrate.positions, 1)
})
