import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createPool, migrate, schemaVersion } from '@vibe-invest/db'

const root = fileURLToPath(new URL('../', import.meta.url))
const arguments_ = process.argv.slice(2)
const mode = arguments_.find((argument) => argument.startsWith('--')) ?? '--all'
if (!['--all', '--unit', '--db', '--setup'].includes(mode)) throw new Error(`未知测试模式：${mode}`)
const requested = arguments_.filter((argument) => !argument.startsWith('--'))
const workspaces = ['apps/web', 'services/analysis-api', 'packages/contracts', 'packages/db', 'packages/domain']
const tests = workspaces.flatMap((workspace) => [...globSync('**/*.test.{ts,tsx}', { cwd: resolve(root, workspace), exclude: ['node_modules/**', 'dist/**'] })]
  .sort().map((file) => ({
    workspace, file, path: `${workspace}/${file}`,
    database: /\bTEST_(?:MIGRATION_)?DATABASE_URL\b/.test(readFileSync(resolve(root, workspace, file), 'utf8')),
  })))
for (const path of requested) {
  if (!tests.some((test) => test.path === path)) throw new Error(`未找到测试文件：${path}`)
}
const selected = tests.filter((test) => (!requested.length || requested.includes(test.path))
  && (mode !== '--unit' || !test.database) && (mode !== '--db' || test.database))

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`命令失败：${program} ${args.join(' ')}`)
  return result.stdout?.trim()
}

const compose = ['compose', '-p', 'vibe-invest-us-test', '-f', resolve(root, 'compose.test.yaml')]
let admin
let databaseHost
let interrupted = false
let failed = false
process.on('SIGINT', () => { interrupted = true })
process.on('SIGTERM', () => { interrupted = true })

function databaseUrl(database, role = 'vibe_invest_app') {
  const passwords = {
    vibe_invest_bootstrap: 'local-test-bootstrap-only',
    vibe_invest_migration: 'local-test-migration-only',
    vibe_invest_app: 'local-test-application-only',
  }
  return `postgresql://${role}:${passwords[role]}@${databaseHost}/${database}`
}

async function prepareDatabase(name) {
  assert.match(name, /^vibe_invest_test(?:_[a-z0-9_]+)?$/)
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (!existing.rowCount) await admin.query(`CREATE DATABASE "${name}" OWNER vibe_invest_migration`)
  const pool = createPool(databaseUrl(name, 'vibe_invest_bootstrap'))
  try {
    await pool.query(`
      ALTER SCHEMA public OWNER TO vibe_invest_migration;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE TEMPORARY ON DATABASE "${name}" FROM PUBLIC;
      GRANT CONNECT ON DATABASE "${name}" TO vibe_invest_app;
      GRANT USAGE ON SCHEMA public TO vibe_invest_app;
    `)
  } finally { await pool.end() }
  await migrate(databaseUrl(name, 'vibe_invest_migration'))
}

async function preparePostgres() {
  const contexts = JSON.parse(command('docker', ['context', 'inspect'], { stdio: 'pipe' }))
  const endpoint = process.env.DOCKER_HOST ?? contexts[0]?.Endpoints?.docker?.Host ?? ''
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) {
    throw new Error('数据库测试只允许使用本机 Docker，不能连接远端 Docker 主机。')
  }
  command('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '90', 'postgres'])
  databaseHost = command('docker', [...compose, 'port', 'postgres', '5432'], { stdio: 'pipe' })
  assert.match(databaseHost, /^127\.0\.0\.1:\d+$/)
  admin = createPool(databaseUrl('vibe_invest', 'vibe_invest_bootstrap'))
  await prepareDatabase('vibe_invest_test')
  const pool = createPool(databaseUrl('vibe_invest_test'))
  try {
    const result = await pool.query(`SELECT
      current_setting('server_version') AS postgres,
      (SELECT max(version) FROM product_schema_migrations) AS version,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp`)
    assert.equal(result.rows[0].version, schemaVersion)
    assert.equal(result.rows[0].can_create, false)
    assert.equal(result.rows[0].can_temp, false)
    console.log(`本地测试库 ${databaseHost}/vibe_invest_test，PostgreSQL ${result.rows[0].postgres}，schema ${schemaVersion}；应用与迁移角色独立。`)
  } finally { await pool.end() }
}

function runTests(workspace, files, environment = {}) {
  console.log(`\n运行 ${workspace}：${files.join(', ')}`)
  const env = { ...process.env }
  delete env.TEST_DATABASE_URL
  delete env.TEST_MIGRATION_DATABASE_URL
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
    cwd: resolve(root, workspace), stdio: 'inherit', env: { ...env, ...environment },
  })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}

try {
  if (mode === '--setup' || selected.some((test) => test.database)) await preparePostgres()
  if (mode !== '--setup') {
    for (const workspace of workspaces) {
      if (interrupted) break
      const files = selected.filter((test) => test.workspace === workspace && !test.database).map(({ file }) => file)
      if (files.length) runTests(workspace, files)
    }
    const runId = `${Date.now().toString(36)}_${process.pid}`
    let index = 0
    for (const test of selected.filter((test) => test.database)) {
      if (interrupted) break
      const name = `vibe_invest_test_${runId}_${index++}`
      try {
        await prepareDatabase(name)
        runTests(test.workspace, [test.file], {
          TEST_DATABASE_URL: databaseUrl(name),
          TEST_MIGRATION_DATABASE_URL: databaseUrl(name, 'vibe_invest_migration'),
        })
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      }
    }
  }
} finally { await admin?.end() }

if (interrupted) process.exitCode = 130
else if (failed) process.exitCode = 1
