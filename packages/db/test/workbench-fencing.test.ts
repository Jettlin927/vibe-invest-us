import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  createAgentEventRepository, createConversationRepository, createPortfolioRepository,
  createWorkbenchRepository, migrate,
} from '../src/index.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL

test('真实 PostgreSQL：等待业务锁期间停止执行，迟到成交与页面写入整体回滚', {
  skip: !databaseUrl || !migrationUrl, timeout: 15_000,
}, async () => {
  await migrate(migrationUrl!)
  const prefix = randomUUID()
  const pool = new Pool({ connectionString: databaseUrl, application_name: `fencing-${prefix}` })
  const admin = new Pool({ connectionString: migrationUrl })
  const holder = await admin.connect()
  const portfolio = createPortfolioRepository(pool)
  const workbench = createWorkbenchRepository(pool)
  const symbol = `F${prefix.replaceAll('-', '').slice(0, 10).toUpperCase()}`
  const threadIds: string[] = []
  const cashBefore = await portfolio.cash()
  try {
    await portfolio.recordCashAdjustment(1000, prefix)
    for (const kind of ['trade', 'page'] as const) {
      const id = `${prefix}-${kind}`
      threadIds.push(id)
      await createConversationRepository(pool).create({
        id, sessionId: id, executionId: id, segmentId: id, title: '写入隔离测试',
        operationId: `${id}-create`, createdAt: new Date().toISOString(),
        event: { type: 'user_message', message: '保存操作' },
      })
      const operationId = `${id}-write`
      const lockKey = kind === 'trade' ? operationId : `workbench:operation:${operationId}`
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
      const pending = (kind === 'trade'
        ? portfolio.recordBuy(symbol, 2, 100, '', operationId, id)
        : workbench.savePage({ operationId, title: prefix, blocks: [{ type: 'positions' }] }, id)
      ).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }))
      // 先确认业务 SQL 确实在等锁，再执行停止，避免只测试调用前的取消。
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const waiting = await admin.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0) AS blocked',
          [`fencing-${prefix}`],
        )
        blocked = waiting.rows[0]!.blocked
        if (!blocked) await setTimeout(10)
      }
      assert.ok(blocked, '业务写入应已进入数据库锁等待')
      await createAgentEventRepository(pool).fenceForStopping({
        sessionId: id, executionId: id, fenceExecutionId: `${id}-fence`,
        operationId: `${id}-stop`, createdAt: new Date().toISOString(),
        event: { type: 'status', status: 'stopping' },
      })
      await holder.query('COMMIT')
      const outcome = await pending
      assert.ok(outcome.error instanceof Error)
      assert.match(outcome.error.message, /agent_execution_fenced/)
      assert.equal(await portfolio.cash(), 1000)
      assert.ok(!(await portfolio.list()).some((position) => position.symbol === symbol))
      assert.ok(!(await workbench.listPages()).some((page) => page.title === prefix))
      await assert.rejects(workbench.saveStance({
        operationId: `${id}-stance`, symbol, stance: '迟到判断', status: 'pending', conditions: [],
        sourceThreadId: id, sourceRecordId: null,
      }, id), /agent_execution_fenced/)
      assert.deepEqual(await workbench.listStances(symbol), [])
    }
    const counts = await admin.query<{ trades: number; operations: number }>(
      `SELECT (SELECT count(*)::integer FROM portfolio_events WHERE symbol=$1) AS trades,
        (SELECT count(*)::integer FROM workbench_operations WHERE operation_id LIKE $2) AS operations`,
      [symbol, `${prefix}%`],
    )
    assert.deepEqual(counts.rows[0], { trades: 0, operations: 0 })
  } finally {
    await holder.query('ROLLBACK')
    holder.release()
    await portfolio.recordCashAdjustment(cashBefore, prefix)
    await admin.query('DELETE FROM analyses WHERE id = ANY($1::text[])', [threadIds])
    await pool.end()
    await admin.end()
  }
})
