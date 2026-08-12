import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const productionRoots = ['services/analysis-api/src', 'apps/web/src', 'packages']
  .map((path) => join(root, path))
const execFileAsync = promisify(execFile)

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

test('只有 Pi Adapter 可直接导入 pi-agent-core', async () => {
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    if (source.includes('@earendil-works/pi-agent-core')) {
      assert.equal(relative(root, file), 'services/analysis-api/src/agent-runtime/pi-agent-adapter.ts')
    }
  }
})

test('生产代码静态禁止 Pi 持久化、Harness、文件和 Shell 能力', async () => {
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat()
  const forbiddenEverywhere = /@earendil-works\/pi-coding-agent|pi-agent-core\/(?:node|session|harness)/i
  const forbiddenPiCapability = /AgentHarness|SessionRepo|Jsonl|JSONL|NodeExecutionEnv|create(Read|Write|Edit|Bash)Tool/i
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, forbiddenEverywhere, relative(root, file))
    assert.doesNotMatch(source, forbiddenPiCapability, relative(root, file))
  }
})

test('Pi 与 Pi AI 使用相同精确版本', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'services/analysis-api/package.json'), 'utf8'))
  assert.equal(packageJson.dependencies['@earendil-works/pi-agent-core'], '0.84.1')
  assert.equal(packageJson.dependencies['@earendil-works/pi-ai'], '0.84.1')
})

test('Adapter 公开声明不泄露 Pi 类型，调用方无需导入 Pi 包', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-pi-public-contract-'))
  try {
    await execFileAsync(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--declaration', '--emitDeclarationOnly', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2024', '--strict', '--skipLibCheck', '--outDir', directory,
      join(root, 'services/analysis-api/src/agent-runtime/pi-agent-adapter.ts'),
    ])
    const declaration = await readFile(join(directory, 'pi-agent-adapter.d.ts'), 'utf8')
    assert.doesNotMatch(declaration, /@earendil-works\/pi-(?:agent-core|ai)|typebox/)

    const testSource = await readFile(join(root, 'services/analysis-api/test/pi-agent-adapter.test.ts'), 'utf8')
    assert.doesNotMatch(
      testSource,
      /from ['"]@earendil-works\/pi-(?:agent-core|ai)['"]|from ['"]typebox['"]/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Adapter 从 pi-agent-core 包根导入仅限显式 allowlist', async () => {
  const source = await readFile(
    join(root, 'services/analysis-api/src/agent-runtime/pi-agent-adapter.ts'), 'utf8',
  )
  const packageImports = [...source.matchAll(
    /import\s+([\s\S]*?)\s+from\s+['"]@earendil-works\/pi-agent-core['"]/g,
  )]
  assert.equal(packageImports.length, 1, '必须且只能存在一条 pi-agent-core 包根 import')
  assert.equal(
    [...source.matchAll(/['"]@earendil-works\/pi-agent-core['"]/g)].length,
    1,
    '拒绝额外、side-effect 或无法解析的 pi-agent-core 包根 import',
  )
  const clause = packageImports[0]![1]!.trim()
  assert.match(clause, /^\{[\s\S]*\}$/, '只允许 pi-agent-core named import')
  const imports = clause.slice(1, -1).split(',')
    .map((name) => name.replace(/\btype\s+/g, '').trim())
    .filter(Boolean)
    .sort()
  assert.deepEqual(imports, [
    'Agent', 'AgentTool', 'estimateContextTokens', 'prepareCompaction', 'shouldCompact',
  ].sort())
})
