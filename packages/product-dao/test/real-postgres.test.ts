import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createPool,
  createPortfolioRepository, migrate,
} from '../src/index.js'

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL
const applicationUrl = process.env.TEST_DATABASE_URL

test('真实 PostgreSQL migration 幂等且 application role 没有 DDL 权限', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  await migrate(migrationUrl!)

  const pool = createPool(applicationUrl!)
  assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 5 })
  const privileges = await pool.query<{ can_create: boolean; can_temp: boolean }>(
    `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
            has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp`,
  )
  assert.deepEqual(privileges.rows, [{ can_create: false, can_temp: false }])
  await pool.query(
    `INSERT INTO positions (symbol, quantity, average_cost, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (symbol) DO UPDATE SET quantity = excluded.quantity`,
    ['T01', '1.25', '2.50', '2026-08-13T00:00:00.000Z'],
  )
  const stored = await pool.query<{ quantity: string; average_cost: string }>(
    'SELECT quantity, average_cost FROM positions WHERE symbol = $1',
    ['T01'],
  )
  assert.deepEqual(stored.rows, [{ quantity: '1.25', average_cost: '2.50' }])
  await assert.rejects(
    pool.query('CREATE TABLE forbidden_by_application_role (id integer)'),
    /permission denied/,
  )
  await pool.end()
})

test('application role 的事务失败会回滚产品写入', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO positions (symbol, quantity, average_cost, updated_at) VALUES ($1, $2, $3, $4)',
      ['ROLLBACK', '3', '4', '2026-08-13T00:00:00.000Z'],
    )
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
  const result = await pool.query('SELECT symbol FROM positions WHERE symbol = $1', ['ROLLBACK'])
  assert.deepEqual(result.rows, [])
  await pool.end()
})

test('真实 PostgreSQL 持仓 DAO 完成 CRUD、现金和原子减仓', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  try {
    const portfolio = createPortfolioRepository(pool)
    await portfolio.remove('NVDA')
    await portfolio.setCash(500)
    await portfolio.save({ symbol: 'NVDA', quantity: 10.125, averageCost: 100.25 })
    assert.deepEqual((await portfolio.list()).find(({ symbol }) => symbol === 'NVDA'),
      { symbol: 'NVDA', quantity: 10.125, averageCost: 100.25 })
    assert.deepEqual(await portfolio.reduce('NVDA', 0.125, 125.5), {
      position: { symbol: 'NVDA', quantity: 10, averageCost: 100.25 },
      cash: 515.6875,
      proceeds: 15.6875,
      realizedProfitLoss: 3.15625,
    })
    assert.equal(await portfolio.cash(), 515.6875)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 研究 DAO 保存任务、事实、轨迹并安全删除', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const id = 'dao-analysis-test'
  try {
    await repository.removeResearch(id)
    const now = '2026-08-13T00:00:00.000Z'
    await repository.createOrReturn({ id, symbol: 'NVDA', status: 'queued', createdAt: now, updatedAt: now })
    await repository.saveFact(id, { id: 'dao-fact-test', type: 'quote', value: 100 })
    await repository.appendTrace(id, { type: 'status', status: 'queued' })
    await repository.saveSnapshot(id, { symbol: 'NVDA' })
    await repository.setStatus(id, 'completed', now, { report: { title: 'DAO 测试' } })
    const research = await repository.research(id)
    assert.equal(research?.status, 'completed')
    assert.deepEqual(research?.snapshot, { symbol: 'NVDA' })
    assert.deepEqual(research?.report, { title: 'DAO 测试' })
    assert.deepEqual(research?.facts, [{ id: 'dao-fact-test', type: 'quote', value: 100 }])
    assert.deepEqual(research?.trace, [{ type: 'status', status: 'queued' }])
    assert.equal(await repository.removeResearch(id), true)
    assert.equal(await repository.get(id), null)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 并发创建同一标的只产生一个首次研究', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const symbol = 'CONCURRENT-CREATE'
  try {
    await pool.query('DELETE FROM analyses WHERE symbol = $1', [symbol])
    const now = '2026-08-13T00:00:00.000Z'
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      repository.createOrReturn({
        id: `concurrent-create-${index}`, symbol, status: 'queued', createdAt: now, updatedAt: now,
      })
    )))
    assert.equal(new Set(results.map(({ analysisId }) => analysisId)).size, 1)
    assert.equal(results.filter(({ created }) => created).length, 1)
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM analyses
       WHERE symbol = $1 AND status IN ('queued', 'running')`, [symbol],
    )
    assert.equal(rows.rows[0]?.count, 1)
  } finally {
    await pool.query('DELETE FROM analyses WHERE symbol = $1', [symbol])
    await pool.end()
  }
})

test('真实 PostgreSQL 并发队列 claim 每个任务只会被领取一次', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const prefix = 'concurrent-claim-'
  try {
    await pool.query('DELETE FROM analyses WHERE id LIKE $1', [`${prefix}%`])
    const now = '2026-08-13T00:00:00.000Z'
    for (let index = 0; index < 8; index += 1) {
      await repository.createOrReturn({
        id: `${prefix}${index}`, symbol: `CLAIM-${index}`, status: 'queued', createdAt: now, updatedAt: now,
      })
    }
    const claimed = await Promise.all(Array.from({ length: 24 }, () => repository.claimNextQueued(now)))
    const ids = claimed.filter((id): id is string => Boolean(id))
    assert.equal(ids.length, 8)
    assert.equal(new Set(ids).size, 8)
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM analyses
       WHERE id LIKE $1 AND status = 'running'`, [`${prefix}%`],
    )
    assert.equal(rows.rows[0]?.count, 8)
  } finally {
    await pool.query('DELETE FROM analyses WHERE id LIKE $1', [`${prefix}%`])
    await pool.end()
  }
})

test('真实 PostgreSQL 并发追加轨迹无丢失且 sequence 严格连续', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(pool)
  const id = 'concurrent-trace'
  try {
    await repository.removeResearch(id)
    const now = '2026-08-13T00:00:00.000Z'
    await repository.createOrReturn({ id, symbol: 'TRACE', status: 'queued', createdAt: now, updatedAt: now })
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      repository.appendTrace(id, { type: 'concurrent', index })
    )))
    const rows = await pool.query<{ sequence: number }>(
      'SELECT sequence FROM analysis_trace WHERE analysis_id = $1 ORDER BY sequence', [id],
    )
    assert.deepEqual(rows.rows.map(({ sequence }) => sequence), Array.from({ length: 40 }, (_, index) => index + 1))
  } finally {
    await repository.removeResearch(id)
    await pool.end()
  }
})

test('真实 PostgreSQL Agent Session 事件 sequence 严格递增且 operationId 幂等', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const sessionId = 'agent-event-ledger-session'
  try {
    await analyses.removeResearch(sessionId)
    const now = '2026-08-13T00:00:00.000Z'
    const created = await events.createSession({
      id: sessionId,
      symbol: 'LEDGER',
      status: 'queued',
      operationId: 'create-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })
    assert.deepEqual({ analysisId: created.analysisId, created: created.created }, {
      analysisId: sessionId, created: true,
    })
    const concurrent = await Promise.all(Array.from({ length: 40 }, (_, index) => (
      events.append({
        sessionId,
        operationId: `trace-${index}`,
        event: { type: 'trace', index },
        createdAt: now,
      })
    )))
    const first = await events.append({
      sessionId,
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const replay = await events.append({
      sessionId,
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const concurrentReplay = await Promise.all(Array.from({ length: 20 }, () => events.append({
      sessionId,
      operationId: 'one-concurrent-operation',
      event: { type: 'trace', value: 'only-once' },
      createdAt: now,
    })))

    assert.equal(new Set(concurrent.map(({ sequence }) => sequence)).size, 40)
    assert.equal(replay.sequence, first.sequence)
    assert.equal(replay.created, false)
    assert.equal(new Set(concurrentReplay.map(({ sequence }) => sequence)).size, 1)
    assert.equal(concurrentReplay.filter(({ created }) => created).length, 1)
    assert.deepEqual((await events.list(sessionId, 0)).map(({ sequence }) => sequence),
      Array.from({ length: 43 }, (_, index) => index + 1))
    assert.equal((await events.getSession(sessionId))?.status, 'completed')
    assert.equal((await analyses.get(sessionId))?.status, 'completed')
    await assert.rejects(
      pool.query(
        'UPDATE agent_events SET operation_id = $1 WHERE session_id = $2 AND sequence = 1',
        ['forbidden-update', sessionId],
      ),
      /permission denied/,
    )
  } finally {
    await analyses.removeResearch(sessionId)
    await pool.end()
  }
})

test('真实 PostgreSQL 事件与 Session 读取投影在投影失败时一起回滚', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const sessionId = 'agent-event-rollback-session'
  try {
    await analyses.removeResearch(sessionId)
    const now = '2026-08-13T00:00:00.000Z'
    await events.createSession({
      id: sessionId,
      symbol: 'ROLLBACK-EVENT',
      status: 'queued',
      operationId: 'create-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })

    await assert.rejects(events.append({
      sessionId,
      operationId: 'invalid-projection',
      event: { type: 'status', status: '', at: now },
      projection: { status: '', facts: [{ id: 'rolled-back-fact', type: 'quote', value: 100 }] },
      createdAt: now,
    }))

    assert.equal((await events.getSession(sessionId))?.latestSequence, 1)
    assert.deepEqual(await events.list(sessionId, 1), [])
    assert.equal((await analyses.get(sessionId))?.status, 'queued')
    assert.deepEqual((await analyses.research(sessionId))?.facts, [])
  } finally {
    await analyses.removeResearch(sessionId)
    await pool.end()
  }
})
