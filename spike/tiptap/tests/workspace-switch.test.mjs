import test from 'node:test'
import assert from 'node:assert/strict'
import { switchWorkspaceSafely } from '../src/workspaceSwitch'

test('workspace switching drains pending saves before activation and never thaws the old editor after success', async () => {
  const events = []
  const lifecycle = { save: async () => { events.push('save') }, freeze: () => events.push('freeze'), thaw: () => events.push('thaw'), opened: () => events.push('opened') }
  await switchWorkspaceSafely(async () => events.push('activate'), lifecycle)
  assert.deepEqual(events, ['save', 'freeze', 'activate', 'opened'])
  events.length = 0
  await assert.rejects(switchWorkspaceSafely(async () => { events.push('failed activation'); throw new Error('network') }, lifecycle), /network/)
  assert.deepEqual(events, ['save', 'freeze', 'failed activation', 'thaw'])
  events.length = 0
  await assert.rejects(switchWorkspaceSafely(async () => events.push('must not activate'), { ...lifecycle, save: async () => { throw new Error('local save failed') } }), /local save failed/)
  assert.deepEqual(events, [])
})
