import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildApp } from '../src/app.js'

test('聚合健康状态包含 Analysis API、SQLite 和 Financial Data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-health-'))
  const app = buildApp({
    databasePath: join(dataDir, 'app.db'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })

  const response = await app.inject({ method: 'GET', url: '/api/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    service: 'analysis-api',
    status: 'ok',
    dependencies: {
      database: { status: 'ok' },
      financialData: { service: 'financial-data', status: 'ok' },
    },
  })

  await app.close()
})

test('生产入口由 Analysis API 托管编译后的 Web', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibe-invest-web-'))
  const staticDir = join(dataDir, 'web')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(staticDir))
  await writeFile(join(staticDir, 'index.html'), '<h1>vibe-invest health</h1>')

  const app = buildApp({
    databasePath: join(dataDir, 'app.db'),
    staticDir,
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
  })

  const response = await app.inject({ method: 'GET', url: '/' })

  assert.equal(response.statusCode, 200)
  assert.match(response.body, /vibe-invest health/)
  assert.match(response.headers['content-type'] ?? '', /text\/html/)

  await app.close()
})

test('Settings 只暴露模型是否可用且不返回凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-settings-'))
  const app = buildApp({
    databasePath: join(directory, 'app.db'),
    financialDataHealth: async () => ({ service: 'financial-data', status: 'ok' }),
    modelConfigured: true,
  })
  const response = await app.inject({ method: 'GET', url: '/api/settings' })
  assert.deepEqual(response.json(), { model: { configured: true } })
  assert.equal(response.body.includes('key'), false)
  await app.close()
})
