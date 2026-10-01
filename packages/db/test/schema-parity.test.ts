import assert from 'node:assert/strict'
import test from 'node:test'
import { createPool, createPortfolioRepository, migrate } from '../src/index.js'

const applicationUrl = process.env.TEST_DATABASE_URL
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL

test('真实 PostgreSQL：权益快照观测时间保留时区并修复旧文本定义', {
  skip: !applicationUrl || !migrationUrl,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const admin = createPool(migrationUrl!)
  const repository = createPortfolioRepository(pool)
  const columnType = async () => (await admin.query(`SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'portfolio_equity_snapshots' AND column_name = 'observed_at'`)).rows[0].data_type
  const snapshot = {
    marketDay: '2099-01-01', totalEquity: 100, totalMarketValue: 80, cash: 20,
    holdingsCount: 1, pricedCount: 1, observedAt: '2099-01-02T04:00:00+08:00', afterClose: true,
  }
  try {
    assert.equal(await columnType(), 'timestamp with time zone')
    await repository.saveSnapshot(snapshot)
    assert.equal((await repository.listSnapshots(1))[0]?.observedAt, '2099-01-01T20:00:00.000Z')
    await assert.rejects(repository.saveSnapshot({ ...snapshot, observedAt: 'invalid-time' }), /invalid input syntax for type timestamp/)

    await admin.query(`ALTER TABLE portfolio_equity_snapshots ALTER COLUMN observed_at TYPE text USING observed_at::text;
      ALTER TABLE portfolio_equity_snapshots ADD CONSTRAINT portfolio_equity_snapshots_observed_at_check CHECK (observed_at <> '')`)
    await migrate(migrationUrl!)
    await migrate(migrationUrl!)
    assert.equal(await columnType(), 'timestamp with time zone')
    assert.equal((await repository.listSnapshots(1))[0]?.observedAt, '2099-01-01T20:00:00.000Z')
  } finally {
    await admin.query('DELETE FROM portfolio_equity_snapshots WHERE market_day = $1', [snapshot.marketDay])
    await pool.end()
    await admin.end()
  }
})
