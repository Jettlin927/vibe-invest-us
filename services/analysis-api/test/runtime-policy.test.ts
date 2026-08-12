import assert from 'node:assert/strict'
import test from 'node:test'

import { createConcurrencyGate } from '../src/runtime-policy.js'

test('并发槽拒绝预先取消的等待者且不会泄漏槽位', async () => {
  const gate = createConcurrencyGate()
  const release = await gate.acquire(1, new AbortController().signal)
  const controller = new AbortController()
  controller.abort(new Error('already_cancelled'))

  await assert.rejects(gate.acquire(1, controller.signal), /already_cancelled/)
  release()
  const nextRelease = await gate.acquire(1, new AbortController().signal)
  nextRelease()
})

test('并发槽未满时也拒绝预先取消的请求', async () => {
  const gate = createConcurrencyGate()
  const controller = new AbortController()
  controller.abort(new Error('already_cancelled'))

  await assert.rejects(gate.acquire(1, controller.signal), /already_cancelled/)
})
