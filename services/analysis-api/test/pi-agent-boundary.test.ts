import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../../..')
const productionRoots = ['services/analysis-api/src', 'apps/web/src', 'packages']
  .map((path) => join(root, path))

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
