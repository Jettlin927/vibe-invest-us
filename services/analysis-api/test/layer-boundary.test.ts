import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function sources(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  }))).flat()
}

function imports(source: ts.SourceFile) {
  const result: string[] = []
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      const argument = node.arguments[0]
      assert.ok(argument && ts.isStringLiteral(argument), '层间依赖必须是静态可检查的路径')
      result.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('domain、service、api、db 和 Web 保持单向职责依赖', async () => {
  for (const directory of ['packages/domain/src', 'packages/db/src', 'services/analysis-api/src', 'apps/web/src']) {
    for (const path of await sources(join(root, directory))) {
      const name = relative(root, path)
      const text = await readFile(path, 'utf8')
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      for (const specifier of imports(source)) {
        const target = specifier.startsWith('.') ? relative(root, resolve(dirname(path), specifier)) : specifier
        if (name.startsWith('packages/domain/')) {
          assert.ok(target.startsWith('packages/domain/') || target === '@vibe-invest/contracts', `${name} → ${target}`)
        }
        if (name.startsWith('packages/db/')) assert.doesNotMatch(target, /^(services\/|apps\/)|fastify|pi-agent|pi-ai/, `${name} → ${target}`)
        if (name.includes('/src/api/') && name.startsWith('services/')) assert.doesNotMatch(target, /@vibe-invest\/db|packages\/db|\/adapters\/|^pg$/, `${name} → ${target}`)
        if (name.includes('/src/service/')) assert.doesNotMatch(target, /^services\/analysis-api\/src\/api\/|fastify|^pg$/, `${name} → ${target}`)
        if (name.startsWith('apps/web/')) assert.doesNotMatch(target, /^(services\/|packages\/db)|@vibe-invest\/(db|domain)|^pg$/, `${name} → ${target}`)
      }
      if (name.startsWith('packages/domain/')) assert.doesNotMatch(text, /\bfetch\s*\(|\bprocess\.env|\bset(?:Timeout|Interval)\s*\(/, name)
      if (name.startsWith('apps/web/') && !name.includes('/src/api/')) assert.doesNotMatch(text, /\bfetch\s*\(|\bnew EventSource\s*\(|['"`]\/api\//, name)
    }
  }
})
