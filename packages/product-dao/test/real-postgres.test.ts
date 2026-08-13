import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'

import { defaultRuntimeSettings } from '@vibe-invest/contracts'

import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createPool,
  createPortfolioRepository, createRuntimeSettingsRepository, migrate,
} from '../src/index.js'

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL
const applicationUrl = process.env.TEST_DATABASE_URL

test('真实 PostgreSQL 保存不可变 Runtime settings revision 并可恢复默认值', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  try {
    const defaults = await settings.restoreDefaults('2026-08-13T01:00:00.000Z')
    const changed = await settings.save({
      mainAgentToolRounds: 100,
      modelRequestTimeoutMinutes: 60,
    }, '2026-08-13T01:01:00.000Z')
    const restored = await settings.restoreDefaults('2026-08-13T01:02:00.000Z')

    assert.notEqual(defaults.id, changed.id)
    assert.notEqual(changed.id, restored.id)
    assert.equal((await settings.getRevision(changed.id))?.values.mainAgentToolRounds, 100)
    assert.equal((await settings.getRevision(changed.id))?.values.modelRequestTimeoutMinutes, 60)
    assert.equal(restored.values.mainAgentToolRounds, 20)
    assert.equal(restored.values.modelRequestTimeoutMinutes, 15)
    await assert.rejects(
      pool.query('UPDATE runtime_settings_revisions SET settings_json = $1 WHERE id = $2', ['{}', changed.id]),
      /permission denied/,
    )
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL execution 冻结 settings snapshot 后不随新 revision 改变', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const executionId = 'settings-snapshot-execution'
  try {
    await settings.restoreDefaults('2026-08-13T02:00:00.000Z')
    const frozen = await settings.freezeExecution(executionId, '2026-08-13T02:01:00.000Z')
    await settings.save({ mainAgentToolRounds: 200 }, '2026-08-13T02:02:00.000Z')

    assert.equal(frozen.values.mainAgentToolRounds, 20)
    assert.equal((await settings.getExecutionSnapshot(executionId))?.values.mainAgentToolRounds, 20)
    assert.equal((await settings.current()).values.mainAgentToolRounds, 200)
    assert.deepEqual(await settings.freezeExecution(executionId, '2026-08-13T02:03:00.000Z'), frozen)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL 主与专项 execution 创建时原子冻结 settings snapshot', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const events = createAgentEventRepository(pool)
  const migrationPool = createPool(migrationUrl!)
  const analysisId = 'settings-snapshot-all-sessions'
  try {
    await settings.restoreDefaults('2026-08-13T02:04:00.000Z')
    await settings.save({ mainAgentToolRounds: 101 }, '2026-08-13T02:05:00.000Z')
    await events.createResearch({
      analysisId,
      sessionId: 'settings-snapshot-main',
      executionId: 'settings-snapshot-main-execution',
      symbol: 'SNAPALL',
      status: 'queued',
      operationId: 'create-main',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:06:00.000Z',
    })
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-main-execution'))?.values.mainAgentToolRounds,
      101,
    )

    await settings.save({ specialistAgentToolRounds: 202 }, '2026-08-13T02:07:00.000Z')
    await events.createSession({
      id: 'settings-snapshot-specialist',
      analysisId,
      executionId: 'settings-snapshot-specialist-execution',
      status: 'queued',
      operationId: 'create-specialist',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:08:00.000Z',
    })
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-specialist-execution'))?.values.specialistAgentToolRounds,
      202,
    )
    assert.equal(
      (await settings.getExecutionSnapshot('settings-snapshot-main-execution'))?.values.specialistAgentToolRounds,
      20,
    )

    await migrationPool.query('REVOKE INSERT ON execution_settings_snapshots FROM vibe_invest_app')
    await assert.rejects(events.createSession({
      id: 'settings-snapshot-rollback',
      analysisId,
      executionId: 'settings-snapshot-rollback-execution',
      status: 'queued',
      operationId: 'create-rollback',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T02:09:00.000Z',
    }), /permission denied/)
    assert.equal(await events.getSession('settings-snapshot-rollback'), null)
    assert.equal(await settings.getExecutionSnapshot('settings-snapshot-rollback-execution'), null)
  } finally {
    await migrationPool.query('GRANT INSERT ON execution_settings_snapshots TO vibe_invest_app')
    await createAnalysisRepository(pool).removeResearch(analysisId)
    await migrationPool.end()
    await pool.end()
  }
})

test('真实 PostgreSQL 原子创建主 Session、execution generation、初始 segment、Runtime Context 与 settings snapshot', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const events = createAgentEventRepository(pool)
  const settings = createRuntimeSettingsRepository(pool)
  const analysisId = `lifecycle-${crypto.randomUUID()}`
  const sessionId = `session-${crypto.randomUUID()}`
  const executionId = `execution-${crypto.randomUUID()}`
  const symbol = `L${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  const createdAt = '2026-08-13T03:00:00.000Z'
  try {
    await events.createResearch({
      analysisId, sessionId, executionId, segmentId: `segment-${crypto.randomUUID()}`,
      symbol,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: {
        type: 'runtime_context', status: 'planning', executionId, generation: 1,
        waitReason: { kind: 'database', target: '首次研究初始化', startedAt: createdAt },
      },
      createdAt,
    })
    const lifecycle = await events.primaryLifecycle(analysisId)
    assert.equal(lifecycle?.id, sessionId)
    assert.equal(lifecycle?.execution.id, executionId)
    assert.equal(lifecycle?.execution.generation, 1)
    assert.equal(lifecycle?.segments[0]?.ordinal, 1)
    assert.equal(lifecycle?.events[0]?.type, 'runtime_context')
    assert.equal(lifecycle?.waitReason?.target, '首次研究初始化')
    assert.equal((await settings.getExecutionSnapshot(executionId))?.executionId, executionId)

    await assert.rejects(pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`active-${crypto.randomUUID()}`, sessionId, createdAt],
    ), /duplicate key value/)

    await events.append({
      sessionId, executionId, operationId: 'budget-transition',
      event: { type: 'status', status: 'budget_exhausted', terminal: false },
      projection: { status: 'budget_exhausted', executionStatus: 'budget_exhausted' },
      createdAt: '2026-08-13T03:00:01.000Z',
    })
    await assert.rejects(pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`budget-active-${crypto.randomUUID()}`, sessionId, createdAt],
    ), /duplicate key value/)
    const duplicateWhileBudgetClosing = await events.createResearch({
      analysisId: `duplicate-budget-${crypto.randomUUID()}`,
      sessionId: `duplicate-budget-session-${crypto.randomUUID()}`,
      executionId: `duplicate-budget-execution-${crypto.randomUUID()}`,
      symbol,
      status: 'planning', analysisStatus: 'queued', operationId: 'duplicate-budget-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T03:00:01.500Z',
    })
    assert.equal(duplicateWhileBudgetClosing.created, false)
    assert.equal(duplicateWhileBudgetClosing.analysisId, analysisId)
    await events.append({
      sessionId, executionId, operationId: 'budget-terminal',
      event: { type: 'status', status: 'budget_exhausted', terminal: true },
      projection: { status: 'budget_exhausted', executionStatus: 'budget_exhausted' },
      createdAt: '2026-08-13T03:00:02.000Z',
    })
    await pool.query(
      `INSERT INTO agent_executions
       (id, session_id, generation, status, created_at, updated_at)
       VALUES ($1, $2, 2, 'running_model', $3, $3)`,
      [`budget-terminal-${crypto.randomUUID()}`, sessionId, createdAt],
    )
  } finally {
    await createAnalysisRepository(pool).removeResearch(analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL primaryLifecycle 在并发状态写入期间只返回同一事务快照', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const writer = createAgentEventRepository(pool)
  const analysisId = `snapshot-${crypto.randomUUID()}`
  const sessionId = `snapshot-session-${crypto.randomUUID()}`
  const createdAt = '2026-08-13T03:10:00.000Z'
  let executionRead!: () => void
  let continueRead!: () => void
  const executionWasRead = new Promise<void>((resolve) => { executionRead = resolve })
  const writeCompleted = new Promise<void>((resolve) => { continueRead = resolve })
  const wrappedPool = Object.create(pool) as Pool
  const poolQuery = pool.query.bind(pool)
  wrappedPool.query = (async (...args: Parameters<typeof poolQuery>) => {
    const sql = String(args[0])
    if (sql.includes('FROM agent_events')) {
      await executionWasRead
      await writeCompleted
    }
    const result = await poolQuery(...args)
    if (sql.includes('FROM agent_executions') && sql.includes('ORDER BY generation DESC')) {
      executionRead()
      await writeCompleted
    }
    return result
  }) as typeof pool.query
  wrappedPool.connect = (async () => {
    const client = await pool.connect()
    const query = client.query.bind(client)
    client.query = (async (...args: Parameters<typeof query>) => {
      const result = await query(...args)
      const sql = String(args[0])
      if (sql.includes('FROM agent_executions') && sql.includes('ORDER BY generation DESC')) {
        executionRead()
        await writeCompleted
      }
      return result
    }) as typeof client.query
    return client
  }) as typeof pool.connect
  const reader = createAgentEventRepository(wrappedPool)
  try {
    await writer.createResearch({
      analysisId, sessionId, executionId: `snapshot-execution-${crypto.randomUUID()}`,
      symbol: `S${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' }, createdAt,
    })
    const reading = reader.primaryLifecycle(analysisId)
    await executionWasRead
    await writer.append({
      sessionId, executionId: (await writer.getSession(sessionId))!.executionId,
      operationId: 'running-model',
      event: { type: 'status', status: 'running_model' },
      projection: { status: 'running_model', executionStatus: 'running_model' },
      createdAt: '2026-08-13T03:10:01.000Z',
    })
    continueRead()
    const lifecycle = await reading
    const lastStatus = lifecycle?.events.filter((event) => event.type === 'status').at(-1)?.status
      ?? lifecycle?.events.at(-1)?.status
    assert.equal(lifecycle?.execution.status, 'planning')
    assert.equal(lastStatus, 'planning')
  } finally {
    continueRead()
    await createAnalysisRepository(pool).removeResearch(analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL settings snapshot 失败时不残留 Session、execution、segment 或事件', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const appPool = createPool(applicationUrl!)
  const migrationPool = createPool(migrationUrl!)
  const events = createAgentEventRepository(appPool)
  const analysisId = `rollback-${crypto.randomUUID()}`
  const sessionId = `rollback-session-${crypto.randomUUID()}`
  try {
    await migrationPool.query('REVOKE INSERT ON execution_settings_snapshots FROM vibe_invest_app')
    await assert.rejects(events.createResearch({
      analysisId, sessionId, executionId: `rollback-execution-${crypto.randomUUID()}`,
      symbol: `R${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      status: 'planning', analysisStatus: 'queued', operationId: 'runtime-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T03:10:00.000Z',
    }), /permission denied/)
    assert.equal(await events.getSession(sessionId), null)
    assert.equal(await createAnalysisRepository(appPool).get(analysisId), null)
  } finally {
    await migrationPool.query('GRANT INSERT ON execution_settings_snapshots TO vibe_invest_app')
    await migrationPool.end()
    await appPool.end()
  }
})

test('真实 PostgreSQL 并发保存 Runtime settings 不丢失不同字段更新', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  try {
    await settings.restoreDefaults('2026-08-13T02:10:00.000Z')
    await Promise.all([
      settings.save({ mainAgentToolRounds: 100 }, '2026-08-13T02:11:00.000Z'),
      settings.save({ modelRequestTimeoutMinutes: 60 }, '2026-08-13T02:12:00.000Z'),
    ])
    const current = await settings.current()
    assert.equal(current.values.mainAgentToolRounds, 100)
    assert.equal(current.values.modelRequestTimeoutMinutes, 60)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL save 与 restoreDefaults 共用写锁且不会复活旧设置', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const pool = createPool(applicationUrl!)
  const settings = createRuntimeSettingsRepository(pool)
  const blocker = await pool.connect()
  try {
    await settings.restoreDefaults('2026-08-13T02:13:00.000Z')
    await settings.save({ modelRequestTimeoutMinutes: 60 }, '2026-08-13T02:14:00.000Z')
    await blocker.query('SELECT pg_advisory_lock($1)', [8_613_092])
    let saveSettled = false
    let restoreSettled = false
    const saving = settings.save(
      { mainAgentToolRounds: 100 }, '2026-08-13T02:15:00.000Z',
    ).finally(() => { saveSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const restoring = settings.restoreDefaults(
      '2026-08-13T02:16:00.000Z',
    ).finally(() => { restoreSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(saveSettled, false)
    assert.equal(restoreSettled, false)
    await blocker.query('SELECT pg_advisory_unlock($1)', [8_613_092])
    await Promise.all([saving, restoring])
    assert.deepEqual((await settings.current()).values, defaultRuntimeSettings)
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1)', [8_613_092])
    blocker.release()
    await pool.end()
  }
})

test('真实 PostgreSQL migration 幂等且 application role 没有 DDL 权限', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  await migrate(migrationUrl!)

  const pool = createPool(applicationUrl!)
  assert.deepEqual(await checkSchema(pool), { status: 'ok', version: 12 })
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

test('真实 PostgreSQL 从 v5 升级会移除 Session 一对一约束并回填 primary', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  const migrationPool = createPool(migrationUrl!)
  const analysisId = 'schema-v5-upgrade-analysis'
  const oldSessionId = 'schema-v5-upgrade-main'
  try {
    await migrationPool.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await migrationPool.query('DROP INDEX IF EXISTS agent_sessions_one_primary_per_analysis')
    await migrationPool.query('ALTER TABLE agent_sessions DROP COLUMN IF EXISTS is_primary')
    await migrationPool.query('ALTER TABLE agent_sessions DROP COLUMN IF EXISTS execution_id')
    await migrationPool.query(
      'ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_analysis_id_key UNIQUE (analysis_id)',
    )
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version = 6')
    await migrationPool.query('DELETE FROM product_schema_migrations WHERE version = 7')
    await migrationPool.query(
      `INSERT INTO analyses (id, symbol, status, created_at, updated_at)
       VALUES ($1, 'UPGRADE', 'interrupted', now(), now())`,
      [analysisId],
    )
    await migrationPool.query(
      `INSERT INTO agent_sessions (
         id, analysis_id, status, latest_sequence, created_at, updated_at
       ) VALUES ($1, $2, 'interrupted', 1, now(), now())`,
      [oldSessionId, analysisId],
    )
  } finally {
    await migrationPool.end()
  }

  await migrate(migrationUrl!)
  const applicationPool = createPool(applicationUrl!)
  const events = createAgentEventRepository(applicationPool)
  try {
    assert.equal((await events.findPrimarySession(analysisId))?.id, oldSessionId)
    await events.createSession({
      id: 'schema-v5-upgrade-specialist',
      analysisId,
      executionId: 'schema-v5-upgrade-specialist-execution',
      status: 'queued',
      operationId: 'create-upgraded-specialist',
      event: { type: 'status', status: 'queued' },
      createdAt: '2026-08-13T00:00:00.000Z',
    })
    assert.equal((await events.listSessions(analysisId)).length, 2)
  } finally {
    await applicationPool.end()
    const cleanup = createPool(migrationUrl!)
    await cleanup.query('DELETE FROM analyses WHERE id = $1', [analysisId])
    await cleanup.end()
  }
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
    assert.equal(research?.reportCreatedAt, now)
    await repository.updateResearch(id, { note: '更新备注' }, '2026-08-20T00:00:00.000Z')
    assert.equal((await repository.research(id))?.reportCreatedAt, now)
    assert.deepEqual(research?.facts, [{ id: 'dao-fact-test', type: 'quote', value: 100 }])
    assert.deepEqual(research?.trace, [{ type: 'status', status: 'queued' }])
    assert.equal(await repository.removeResearch(id), true)
    assert.equal(await repository.get(id), null)
  } finally {
    await pool.end()
  }
})

test('真实 PostgreSQL v9 按报告完成事件回填 reportCreatedAt 且无事件时回退更新时间', {
  skip: !migrationUrl || !applicationUrl,
  concurrency: false,
}, async () => {
  const migrationPool = createPool(migrationUrl!)
  const applicationPool = createPool(applicationUrl!)
  const repository = createAnalysisRepository(applicationPool)
  const eventTime = '2026-08-10T03:00:00.000Z'
  const fallbackTime = '2026-08-11T04:00:00.000Z'
  try {
    await migrationPool.query(`
      INSERT INTO analyses (
        id, symbol, status, created_at, updated_at, report_json, report_created_at
      ) VALUES
        ('report-created-at-event', 'RCAEVENT', 'completed', '2026-08-01T00:00:00Z',
         '2026-08-12T00:00:00Z', '{"title":"事件报告"}', NULL),
        ('report-created-at-fallback', 'RCAFALLBACK', 'completed', '2026-08-01T00:00:00Z',
         $1, '{"title":"回退报告"}', NULL)
      ON CONFLICT (id) DO UPDATE SET report_created_at = NULL
    `, [fallbackTime])
    await migrationPool.query(`
      INSERT INTO agent_sessions (
        id, analysis_id, is_primary, execution_id, status, latest_sequence, created_at, updated_at
      ) VALUES (
        'report-created-at-session', 'report-created-at-event', true,
        'report-created-at-execution', 'completed', 1, '2026-08-01T00:00:00Z', $1::timestamptz
      ) ON CONFLICT (id) DO NOTHING
    `, [eventTime])
    await migrationPool.query(`
      INSERT INTO agent_events (
        session_id, sequence, operation_id, payload_json, created_at
      ) VALUES (
        'report-created-at-session', 1, 'report-created-at-completed',
        '{"type":"status","status":"completed"}', $1::timestamptz
      ) ON CONFLICT (session_id, operation_id) DO NOTHING
    `, [eventTime])

    await migrate(migrationUrl!)

    assert.equal((await repository.get('report-created-at-event'))?.reportCreatedAt, eventTime)
    assert.equal((await repository.get('report-created-at-fallback'))?.reportCreatedAt, fallbackTime)
  } finally {
    await migrationPool.query(
      `DELETE FROM analyses WHERE id IN ('report-created-at-event', 'report-created-at-fallback')`,
    )
    await applicationPool.end()
    await migrationPool.end()
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
    const created = await events.createResearch({
      analysisId: sessionId,
      sessionId,
      executionId: 'ledger-execution',
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
        sessionId, executionId: 'ledger-execution',
        operationId: `trace-${index}`,
        event: { type: 'trace', index },
        createdAt: now,
      })
    )))
    const first = await events.append({
      sessionId,
      executionId: 'ledger-execution',
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const replay = await events.append({
      sessionId, executionId: 'ledger-execution',
      operationId: 'complete-session',
      event: { type: 'status', status: 'completed', at: now },
      projection: { status: 'completed' },
      createdAt: now,
    })
    const concurrentReplay = await Promise.all(Array.from({ length: 20 }, () => events.append({
      sessionId, executionId: 'ledger-execution',
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
    await events.createResearch({
      analysisId: sessionId,
      sessionId, executionId: 'rollback-event-execution',
      executionId: 'rollback-event-execution',
      symbol: 'ROLLBACK-EVENT',
      status: 'queued',
      operationId: 'create-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })

    await assert.rejects(events.append({
      sessionId, executionId: 'rollback-event-execution',
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

test('真实 PostgreSQL 同一 analysis 可拥有多个独立 Agent Session 账本', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const analysisId = 'multi-session-analysis'
  try {
    await analyses.removeResearch(analysisId)
    const now = '2026-08-13T00:00:00.000Z'
    const created = await events.createResearch({
      analysisId,
      sessionId: 'multi-session-main',
      executionId: 'multi-session-main-execution',
      symbol: 'MULTI',
      status: 'queued',
      operationId: 'create-main-session',
      event: { type: 'status', status: 'queued', at: now },
      createdAt: now,
    })
    assert.equal(created.sessionId, 'multi-session-main')
    for (const sessionId of ['multi-session-news', 'multi-session-fundamental', 'multi-session-technical']) {
      await events.createSession({
        id: sessionId,
        analysisId,
        executionId: `${sessionId}-execution`,
        status: 'queued',
        operationId: `create:${sessionId}`,
        event: { type: 'status', status: 'queued', at: now },
        createdAt: now,
      })
      await events.append({
        sessionId, executionId: `${sessionId}-execution`,
        operationId: `run:${sessionId}`,
        event: { type: 'status', status: 'running', at: now },
        projection: { status: 'running' },
        createdAt: now,
      })
    }

    const sessions = await events.listSessions(analysisId)
    assert.deepEqual(sessions.map(({ id }) => id), [
      'multi-session-main', 'multi-session-fundamental', 'multi-session-news', 'multi-session-technical',
    ])
    for (const session of sessions) {
      assert.deepEqual((await events.list(session.id, 0)).map(({ sequence }) => sequence),
        session.isPrimary ? [1] : [1, 2])
    }
  } finally {
    await analyses.removeResearch(analysisId)
    await pool.end()
  }
})

test('真实 PostgreSQL 启动恢复在一个事务内中断全部活跃 Session', {
  skip: !applicationUrl,
  concurrency: false,
}, async () => {
  const pool = createPool(applicationUrl!)
  const analyses = createAnalysisRepository(pool)
  const events = createAgentEventRepository(pool)
  const analysisId = 'interrupt-all-analysis'
  const now = '2026-08-13T00:00:00.000Z'
  try {
    await analyses.removeResearch(analysisId)
    await events.createResearch({
      analysisId,
      sessionId: 'interrupt-all-main',
      executionId: 'interrupt-all-main-execution',
      symbol: 'INTERRUPT-ALL',
      status: 'running',
      operationId: 'execution:main:running',
      event: { type: 'status', status: 'running', at: now },
      createdAt: now,
    })
    await events.createSession({
      id: 'interrupt-all-specialist',
      analysisId,
      executionId: 'interrupt-all-specialist-execution',
      status: 'running',
      operationId: 'execution:specialist:running',
      event: { type: 'status', status: 'running', at: now },
      createdAt: now,
    })

    const interrupted = await events.interruptActiveSessions('2026-08-13T00:00:01.000Z')

    assert.deepEqual(interrupted.map(({ sessionId, sequence, operationId }) => ({
      sessionId, sequence, operationId,
    })), [{
      sessionId: 'interrupt-all-main', sequence: 2,
      operationId: 'startup:interrupt:interrupt-all-main:2',
    }, {
      sessionId: 'interrupt-all-specialist', sequence: 2,
      operationId: 'startup:interrupt:interrupt-all-specialist:2',
    }])
    assert.deepEqual((await events.listSessions(analysisId)).map(({ status }) => status),
      ['interrupted', 'interrupted'])
    assert.deepEqual((await Promise.all([
      events.primaryLifecycle(analysisId),
      pool.query<{ status: string }>(
        `SELECT status FROM agent_executions WHERE session_id = 'interrupt-all-specialist'`,
      ).then((result) => result.rows[0]),
    ])).map((value) => value?.status), ['interrupted', 'interrupted'])
    assert.equal((await analyses.get(analysisId))?.status, 'interrupted')
    const replacement = await events.createResearch({
      analysisId: 'interrupt-all-replacement',
      sessionId: 'interrupt-all-replacement-session',
      executionId: 'interrupt-all-replacement-execution',
      symbol: 'INTERRUPT-ALL', status: 'planning', analysisStatus: 'queued',
      operationId: 'interrupt-all-replacement-context',
      event: { type: 'runtime_context', status: 'planning' },
      createdAt: '2026-08-13T00:00:02.000Z',
    })
    assert.equal(replacement.created, true)
    await analyses.removeResearch(replacement.analysisId)
  } finally {
    await analyses.removeResearch(analysisId)
    await pool.end()
  }
})
