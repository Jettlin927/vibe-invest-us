import assert from 'node:assert/strict'
import test from 'node:test'

import { createActiveBudget, createConcurrencyGate } from '../src/runtime-policy.js'

test('并发槽拒绝预先取消的等待者且不会泄漏槽位', async () => {
  const gate = createConcurrencyGate()
  gate.setLimit(1)
  const release = await gate.acquire(new AbortController().signal)
  const controller = new AbortController()
  controller.abort(new Error('already_cancelled'))

  await assert.rejects(gate.acquire(controller.signal), /already_cancelled/)
  release()
  const nextRelease = await gate.acquire(new AbortController().signal)
  nextRelease()
})

test('并发槽未满时也拒绝预先取消的请求', async () => {
  const gate = createConcurrencyGate()
  gate.setLimit(1)
  const controller = new AbortController()
  controller.abort(new Error('already_cancelled'))

  await assert.rejects(gate.acquire(controller.signal), /already_cancelled/)
})

test('execution active budget 对跨层重叠计时只累计一次且共享剩余值', () => {
  let now = 0
  const budget = createActiveBudget(10, () => now, () => new AbortController().signal)
  const parent = new AbortController().signal
  const provider = budget.start(parent)
  now = 3
  const runtime = budget.start(parent)
  now = 8
  runtime.stop()
  assert.equal(budget.elapsedMs(), 8)
  provider.stop()
  assert.equal(budget.elapsedMs(), 8)

  const later = budget.start(parent)
  now = 11
  assert.equal(later.exhausted(), true)
  later.stop()
  assert.equal(budget.exhausted(), true)
})
