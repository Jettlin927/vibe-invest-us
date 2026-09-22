import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createWorkbenchRepository } from '../src/workbench.js'
import { migrate } from '../src/index.js'

test('真实 PostgreSQL：立场和页面保留版本，恢复追加版本，并发重试幂等', { skip: !process.env.TEST_DATABASE_URL || !process.env.TEST_MIGRATION_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL })
  const prefix = randomUUID()
  const symbol = `T${prefix.replaceAll('-', '').slice(0, 10)}`
  const repo = createWorkbenchRepository(pool)
  let pageId = ''
  try {
    await migrate(process.env.TEST_MIGRATION_DATABASE_URL!)
    const sourceThreadId = `${prefix}-thread`, sourceRecordId = `${prefix}-research`, reportVersionId = `${prefix}-report`
    for (const [id, kind] of [[sourceThreadId, 'conversation'], [sourceRecordId, 'research']]) {
      await admin.query("INSERT INTO analyses(id,kind,status,created_at,updated_at) VALUES($1,$2,'completed',now(),now())", [id, kind])
    }
    await admin.query("INSERT INTO agent_sessions(id,analysis_id,is_primary,execution_id,status,created_at,updated_at) VALUES($1,$1,true,$1,'completed',now(),now())", [sourceRecordId])
    await admin.query("INSERT INTO agent_executions(id,session_id,generation,status,terminal,created_at,updated_at) VALUES($1,$1,1,'completed',true,now(),now())", [sourceRecordId])
    await admin.query("INSERT INTO report_versions(id,analysis_id,session_id,execution_id,version,kind,payload_hash,report_json,created_at) VALUES($1,$2,$2,$2,1,'integrated',$3,'{}',now())", [reportVersionId, sourceRecordId, 'a'.repeat(64)])
    const input = { operationId: `${prefix}-stance`, symbol, stance: '等待验证订单', status: 'pending' as const, conditions: ['下次财报检查'], sourceThreadId: null, sourceRecordId: null }
    const results = await Promise.all([repo.saveStance(input), repo.saveStance(input)])
    assert.deepEqual(results[0], results[1])
    await assert.rejects(repo.saveStance({ ...input, stance: '不同参数' }), /workbench_operation_conflict/)
    const second = await repo.saveStance({ ...input, operationId: `${prefix}-stance2`, status: 'confirmed' })
    assert.equal(second.revision, 2)
    assert.deepEqual(await repo.listStances(symbol), [second])
    await assert.rejects(repo.saveStance({ ...input, operationId: `${prefix}-missing-thread`, sourceThreadId: 'missing' }), /invalid_workbench_source_thread/)
    await assert.rejects(repo.saveStance({ ...input, operationId: `${prefix}-wrong-thread`, sourceThreadId: sourceRecordId }), /invalid_workbench_source_thread/)
    await assert.rejects(repo.saveStance({ ...input, operationId: `${prefix}-missing-record`, sourceRecordId: 'missing' }), /invalid_workbench_source_record/)
    await assert.rejects(repo.saveStance({ ...input, operationId: `${prefix}-wrong-report`, sourceRecordId: sourceThreadId, sourceReportVersionId: reportVersionId }), /invalid_workbench_source_report_version/)
    const cited = await repo.saveStance({ ...input, operationId: `${prefix}-cited`, sourceThreadId, sourceRecordId, sourceReportVersionId: reportVersionId })
    assert.equal(cited.sourceRecordKind, 'research')
    assert.equal(cited.sourceReportVersionId, reportVersionId)
    const conversationCited = await repo.saveStance({ ...input, operationId: `${prefix}-chat-cited`, sourceRecordId: sourceThreadId })
    assert.equal(conversationCited.sourceRecordKind, 'conversation')
    const pageInput = { operationId: `${prefix}-page`, title: '持仓判断', blocks: [{ type: 'stances' as const, symbols: [symbol] }] }
    const first = await repo.savePage(pageInput)
    pageId = first.id
    assert.deepEqual(await repo.savePage(pageInput), first)
    await repo.savePage({ ...pageInput, operationId: `${prefix}-page2`, id: first.id, title: '更新后的页面' })
    const restored = await repo.restorePage({ operationId: `${prefix}-restore`, id: first.id, revision: 1 })
    assert.equal(restored.title, first.title)
    assert.equal(restored.revision, 3)
    const read = await repo.getPage(first.id)
    assert.deepEqual(read?.page, restored)
    assert.equal(read?.versions.length, 3)
    await assert.rejects(repo.savePage({ ...pageInput, operationId: `${prefix}-missing`, id: randomUUID() }), /workbench_page_not_found/)
    assert.equal(await repo.getPage(randomUUID()), null)
  } finally {
    await admin.query('DELETE FROM workbench_operations WHERE operation_id LIKE $1', [`${prefix}%`])
    await admin.query('DELETE FROM workbench_versions WHERE entity_id = ANY($1::text[])', [[symbol, pageId]])
    await admin.query('DELETE FROM analyses WHERE id = ANY($1)', [[`${prefix}-thread`, `${prefix}-research`]])
    await pool.end()
    await admin.end()
  }
})
