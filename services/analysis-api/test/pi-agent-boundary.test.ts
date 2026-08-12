import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const piAgentCorePackage = '@earendil-works/pi-agent-core'
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

type PiAgentCoreReference = {
  specifier?: string
  kind: 'import' | 'export' | 'import-equals' | 'dynamic-import' | 'require'
  importDeclaration?: ts.ImportDeclaration
}

function piAgentCoreReferences(source: string): PiAgentCoreReference[] {
  const sourceFile = ts.createSourceFile('boundary.ts', source, ts.ScriptTarget.Latest, true)
  const references: PiAgentCoreReference[] = []
  const addReference = (
    expression: ts.Expression,
    kind: PiAgentCoreReference['kind'],
    importDeclaration?: ts.ImportDeclaration,
  ): void => {
    if (ts.isStringLiteralLike(expression)) {
      if (expression.text.startsWith(piAgentCorePackage)) {
        references.push({ specifier: expression.text, kind, importDeclaration })
      }
    } else if (expression.getText(sourceFile).includes(piAgentCorePackage)) {
      references.push({ kind })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addReference(node.moduleSpecifier, 'import', node)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addReference(node.moduleSpecifier, 'export')
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
    ) {
      addReference(node.moduleReference.expression, 'import-equals')
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length >= 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      addReference(
        node.arguments[0]!,
        node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function assertPiAgentCoreBoundary(source: string, allowlist: string[]): void {
  const references = piAgentCoreReferences(source)
  for (const { specifier } of references) {
    assert.ok(specifier, 'pi-agent-core 禁止动态模块表达式')
    assert.equal(specifier, piAgentCorePackage, 'pi-agent-core 只允许精确包根')
  }
  assert.equal(references.length, 1, '必须且只能存在一条 pi-agent-core 包根 import')
  assert.equal(references[0]!.kind, 'import', 'pi-agent-core 只允许普通静态 import')
  const declaration = references[0]!.importDeclaration
  assert.ok(declaration, 'pi-agent-core 包根必须使用静态 named import')
  assert.equal(declaration.attributes, undefined, 'pi-agent-core import 禁止 attributes/assertClause')
  const clause = declaration.importClause
  assert.ok(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings),
    '只允许 pi-agent-core named import')
  const imports = clause.namedBindings.elements
    .map((element) => (element.propertyName ?? element.name).text)
    .sort()
  assert.deepEqual(imports, [...allowlist].sort())
}

test('只有 Pi Adapter 可直接导入 pi-agent-core', async () => {
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const { specifier } of piAgentCoreReferences(source)) {
      assert.equal(specifier, piAgentCorePackage, 'pi-agent-core 只允许精确包根')
      assert.equal(relative(root, file), 'services/analysis-api/src/agent-runtime/pi-agent-adapter.ts')
    }
  }
})

test('生产代码静态禁止 Pi 持久化、Harness、文件和 Shell 能力', async () => {
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat()
  const forbiddenEverywhere = /@earendil-works\/pi-coding-agent/i
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
  assertPiAgentCoreBoundary(source, [
    'Agent', 'AgentTool', 'estimateContextTokens', 'prepareCompaction', 'shouldCompact',
  ])
})

test('未知 pi-agent-core 子路径在静态、动态和 require 导入中均失败', () => {
  const allowlist = ['Agent']
  for (const source of [
    "import { Agent } from '@earendil-works/pi-agent-core'; import x from '@earendil-works/pi-agent-core/unknown'",
    "import { Agent } from '@earendil-works/pi-agent-core'; void import('@earendil-works/pi-agent-core/unknown')",
    "import { Agent } from '@earendil-works/pi-agent-core'; void import('@earendil-works/pi-agent-core/unknown', { with: { type: 'json' } })",
    "import { Agent } from '@earendil-works/pi-agent-core'; void import(`@earendil-works/pi-agent-core/unknown`)",
    "import { Agent } from '@earendil-works/pi-agent-core'; require('@earendil-works/pi-agent-core/unknown')",
    "import { Agent } from '@earendil-works/pi-agent-core'; require('@earendil-works/pi-agent-core/unknown', {})",
    "import { Agent } from '@earendil-works/pi-agent-core'; require(`@earendil-works/pi-agent-core/unknown`)",
    "import { Agent } from '@earendil-works/pi-agent-core'; import core = require('@earendil-works/pi-agent-core/unknown')",
  ]) {
    assert.throws(() => assertPiAgentCoreBoundary(source, allowlist), /只允许精确包根/)
  }
})

test('Pi Core 的转导出、动态表达式和 import attributes 均失败', () => {
  const allowlist = ['Agent']
  for (const source of [
    "import { Agent } from '@earendil-works/pi-agent-core'; export { Session } from '@earendil-works/pi-agent-core/unknown'",
    "import { Agent } from '@earendil-works/pi-agent-core'; void import(`@earendil-works/pi-agent-core/${suffix}`)",
    "import { Agent } from '@earendil-works/pi-agent-core'; require('@earendil-works/pi-agent-core' + suffix)",
    "import { Agent } from '@earendil-works/pi-agent-core' with { type: 'json' }",
  ]) {
    assert.throws(() => assertPiAgentCoreBoundary(source, allowlist))
  }
})

test('Pi Core 包根也只允许普通静态 named import', () => {
  for (const source of [
    "export { Agent } from '@earendil-works/pi-agent-core'",
    "import core = require('@earendil-works/pi-agent-core')",
    "void import('@earendil-works/pi-agent-core')",
    "require('@earendil-works/pi-agent-core')",
  ]) {
    assert.throws(() => assertPiAgentCoreBoundary(source, ['Agent']), /只允许普通静态 import/)
  }
})
