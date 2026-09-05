import assert from 'node:assert/strict'
import test from 'node:test'
import { createPool, createPortfolioRepository, migrate } from '../src/index.js'
const url = process.env.TEST_DATABASE_URL

test('实际成交通过稳定操作 ID 原子去重并拒绝冲突，重启后保持账本一致', { skip: !url }, async () => {
  await migrate(process.env.TEST_MIGRATION_DATABASE_URL ?? url!)
  const pool = createPool(url!)
  try {
    const repo = createPortfolioRepository(pool)
    await repo.recordCashAdjustment(1000)
    const op = crypto.randomUUID()
    const first = await repo.recordBuy('WBTST', 2, 100, '', op)
    const replay = await repo.recordBuy('WBTST', 2, 100, '', op)
    assert.deepEqual(replay, first)
    assert.equal(await repo.cash(), 800)
    await assert.rejects(repo.recordBuy('WBTST', 3, 100, '', op), /operation_conflict/)
    const sellOp = crypto.randomUUID()
    const sold = await repo.recordSell('WBTST', 1, 120, '', sellOp)
    assert.deepEqual(await repo.recordSell('WBTST', 1, 120, '', sellOp), sold)
    assert.equal(await createPortfolioRepository(pool).cash(), 920)
  } finally { await pool.end() }
})
