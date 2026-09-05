import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  checkSchema, createAgentEventRepository, createAnalysisRepository, createPool,
  createPortfolioRepository, createRuntimeSettingsRepository, createToolProjectionRepository,
  createWorkbenchRepository, createResearchLibraryRepository, migrate,
} from '@vibe-invest/product-dao'
import { buildApp } from '../src/app.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL
function createApp() {
  const pool = createPool(databaseUrl!)
  return buildApp({
    productDatabase: { checkSchema: () => checkSchema(pool), close: () => pool.end() },
    portfolioRepository: createPortfolioRepository(pool), analysisRepository: createAnalysisRepository(pool),
    agentEventRepository: createAgentEventRepository(pool), runtimeSettingsRepository: createRuntimeSettingsRepository(pool),
    toolProjectionRepository: createToolProjectionRepository(pool), workbenchRepository: createWorkbenchRepository(pool),
    researchLibraryRepository: createResearchLibraryRepository(pool),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }), modelConfigured: false,
  })
}

test('真实 PostgreSQL 工作台 API：创建、修改、恢复、重启、幂等和非法配置无副作用', {
  skip: !databaseUrl || !migrationUrl, concurrency: false,
}, async () => {
  await migrate(migrationUrl!)
  const prefix = randomUUID()
  const symbol = `T${prefix.replaceAll('-', '').slice(0, 8)}`.toUpperCase()
  let app = createApp()
  let pageId = ''
  try {
    const payload = { operationId: `${prefix}-create`, title: '持仓决策', blocks: [{ type: 'stances', symbols: [symbol] }] }
    const created = await app.inject({ method: 'POST', url: '/api/workbench/pages', payload })
    assert.equal(created.statusCode, 200, created.body)
    const first = created.json().page
    pageId = first.id
    const retried = await app.inject({ method: 'POST', url: '/api/workbench/pages', payload })
    assert.deepEqual(retried.json().page, first)
    const conflicted = await app.inject({ method: 'POST', url: '/api/workbench/pages', payload: { ...payload, title: '不同参数' } })
    assert.equal(conflicted.statusCode, 409, conflicted.body)
    const updated = await app.inject({ method: 'POST', url: '/api/workbench/pages', payload: { ...payload, id: pageId, operationId: `${prefix}-update`, title: '最新决策', blocks: [{ type: 'positions' }, { type: 'stances', symbols: [symbol] }] } })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.json().page.revision, 2)
    const invalid = await app.inject({ method: 'POST', url: '/api/workbench/pages', payload: { ...payload, id: pageId, operationId: `${prefix}-invalid`, blocks: [{ type: 'html', html: '<script>alert(1)</script>' }] } })
    assert.equal(invalid.statusCode, 400, invalid.body)
    const restored = await app.inject({ method: 'POST', url: `/api/workbench/pages/${pageId}/restore`, payload: { operationId: `${prefix}-restore`, revision: 1 } })
    assert.equal(restored.statusCode, 200, restored.body)
    assert.equal(restored.json().page.revision, 3)
    assert.deepEqual(restored.json().page.blocks, first.blocks)
    const stancePayload = { operationId: `${prefix}-stance`, symbol, stance: '等待下一次披露验证', status: 'pending', conditions: ['检查订单兑现'], sourceThreadId: null, sourceRecordId: null }
    const savedStance = await app.inject({ method: 'POST', url: '/api/workbench/stances', payload: stancePayload })
    assert.equal(savedStance.statusCode, 200, savedStance.body)
    const stanceRetry = await app.inject({ method: 'POST', url: '/api/workbench/stances', payload: stancePayload })
    assert.deepEqual(stanceRetry.json(), savedStance.json())
    await app.close()
    app = createApp()
    const read = await app.inject({ method: 'GET', url: `/api/workbench/pages/${pageId}` })
    assert.equal(read.statusCode, 200, read.body)
    assert.deepEqual(read.json().page, restored.json().page)
    assert.equal(read.json().versions.length, 3)
    const pages = await app.inject({ method: 'GET', url: '/api/workbench/pages' })
    assert.ok(pages.json().pages.some((page: { id: string }) => page.id === pageId))
    const stances = await app.inject({ method: 'GET', url: `/api/workbench/stances?symbol=${symbol}` })
    assert.deepEqual(stances.json().stances.filter((stance: { symbol: string }) => stance.symbol === symbol), [savedStance.json().stance])
  } finally {
    await app.close()
    const admin = createPool(migrationUrl!)
    try {
      await admin.query('DELETE FROM workbench_operations WHERE operation_id LIKE $1', [`${prefix}%`])
      await admin.query('DELETE FROM workbench_versions WHERE entity_id = ANY($1::text[])', [[symbol, pageId]])
    } finally { await admin.end() }
  }
})
