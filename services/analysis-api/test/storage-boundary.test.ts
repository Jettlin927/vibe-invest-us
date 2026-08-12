import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

test('生产存储只使用 Product DAO 和 PostgreSQL', async () => {
  const productionRoots = [
    'services/analysis-api/src',
    'apps/web/src',
    'packages/contracts/src',
    'packages/product-dao/src',
  ].map((path) => join(repositoryRoot, path))
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat()
  const contents = await Promise.all(files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })))

  for (const { path, text } of contents) {
    assert.doesNotMatch(text, /sqlite|DatabaseSync|DATABASE_PATH|\.db\b/i, path)
    if (!path.includes('/packages/product-dao/')) {
      assert.doesNotMatch(text, /from ['"]pg['"]|\.query\s*\(/, path)
    }
  }
})
