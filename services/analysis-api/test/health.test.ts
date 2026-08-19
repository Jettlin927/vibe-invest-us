import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildApp as buildProductionApp } from '../src/app.js'
import { createTestProductDatabase } from './support/product-database.js'

function buildApp(dependencies: Parameters<typeof buildProductionApp>[0]) {
  return buildProductionApp({ ...createTestProductDatabase(), ...dependencies })
}

test('聚合健康状态包含 Analysis API、PostgreSQL schema 和 Financial Data', async () => {
  let schemaChecks = 0
  const app = buildApp({
    productDatabase: {
      checkSchema: async () => { schemaChecks += 1; return { status: 'ok', version: 9 } },
      close: async () => {},
    },
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })

  const response = await app.inject({ method: 'GET', url: '/api/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    service: 'analysis-api',
    status: 'ok',
    dependencies: {
      productDatabase: { status: 'ok', engine: 'postgresql', schemaVersion: 9 },
      financialData: { service: 'financial-data', status: 'ok' },
    },
  })
  assert.equal(schemaChecks, 1)

  await app.close()
})

test('生产入口由 Analysis API 托管编译后的 Web', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-web-'))
  const staticDir = join(dataDir, 'web')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(staticDir))
  await writeFile(join(staticDir, 'index.html'), '<h1>vibe-invest health</h1>')

  const app = buildApp({
    staticDir,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })

  const response = await app.inject({ method: 'GET', url: '/' })

  assert.equal(response.statusCode, 200)
  assert.match(response.body, /vibe-invest health/)
  assert.match(response.headers['content-type'] ?? '', /text\/html/)

  await app.close()
})

test('Settings 暴露模型可用状态与产品设置但不返回凭据', async () => {
  const app = buildApp({
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    modelConfigured: true,
  })
  const response = await app.inject({ method: 'GET', url: '/api/settings' })
  assert.equal(response.json().model.configured, true)
  assert.equal(response.json().current.values.mainAgentToolRounds, 20)
  assert.equal(response.body.includes('key'), false)
  await app.close()
})

test('Settings HTTP 接口读取、修改和恢复版本化 Runtime 设置', async () => {
  const database = createTestProductDatabase()
  const app = buildProductionApp({
    ...database,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    modelConfigured: true,
    now: () => new Date('2026-08-13T03:00:00.000Z'),
  })

  const initial = await app.inject({ method: 'GET', url: '/api/settings' })
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.json().current.values.mainAgentToolRounds, 20)
  assert.equal(initial.json().defaults.mainAgentToolRounds, 20)
  assert.deepEqual(initial.json().activeExecutions, [])

  const updated = await app.inject({
    method: 'PUT', url: '/api/settings',
    payload: { mainAgentToolRounds: 100, modelRequestTimeoutMinutes: 60 },
  })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().values.mainAgentToolRounds, 100)
  assert.equal(updated.json().createdAt, '2026-08-13T03:00:00.000Z')

  const rejected = await app.inject({
    method: 'PUT', url: '/api/settings', payload: { unknown: 1 },
  })
  assert.equal(rejected.statusCode, 400)
  assert.deepEqual(rejected.json(), { error: 'unknown_runtime_setting:unknown' })

  const restored = await app.inject({ method: 'POST', url: '/api/settings/defaults' })
  assert.equal(restored.statusCode, 200)
  assert.equal(restored.json().values.mainAgentToolRounds, 20)
  await app.close()
})

test('Settings 持久化失败保留服务端错误语义', async () => {
  const database = createTestProductDatabase()
  const app = buildProductionApp({
    ...database,
    runtimeSettingsRepository: {
      ...database.runtimeSettingsRepository,
      save: async () => { throw new Error('database_unavailable') },
    },
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })

  const response = await app.inject({
    method: 'PUT', url: '/api/settings', payload: { mainAgentToolRounds: 100 },
  })

  assert.equal(response.statusCode, 500)
  await app.close()
})
