import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkbench } from '../src/workbench.js'
import type { WorkbenchRepository } from '@vibe-invest/product-dao'

test('页面拒绝脚本、未知组件和多余字段，立场拒绝非法状态', async () => {
  const repository = new Proxy({}, { get() { return () => { throw new Error('unexpected_write') } } }) as WorkbenchRepository
  const workbench = createWorkbench(repository)
  for (const blocks of [[{ type: 'html', html: '<script />' }], [{ type: 'positions', html: '<script />' }]]) {
    await assert.rejects(workbench.savePage({ operationId: 'test', title: '页面', blocks }), /invalid_workbench/)
  }
  await assert.rejects(workbench.saveStance({ operationId: 'test', symbol: 'BE', stance: '观察', status: 'traded', conditions: [] }), /invalid_workbench/)
})
