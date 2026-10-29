import test from 'node:test'
import assert from 'node:assert/strict'
import { driveTimestamp, driveVisualState, drivePreferenceGroups } from '../src/drivePresentation'
import { driveSettingKeys } from '../src/driveSettingsPolicy'
test('sync presentation never calls pending, signed-out, paused, offline or conflicted work up to date', () => {
  const connected = { connected: true, signedIn: true, paused: false, state: 'idle', pending: 0, verified: 1000 }
  assert.equal(driveVisualState(connected), 'idle')
  for (const [change, expected] of [[{ pending: 2 }, 'pending'], [{ state: 'pending' }, 'pending'], [{ signedIn: false }, 'signed-out'], [{ checking: true }, 'checking'], [{ paused: true }, 'paused'], [{ state: 'paused' }, 'paused'], [{ state: 'offline', error: 'DRIVE:network' }, 'offline'], [{ reason: 'CONFLICTS' }, 'conflicts'], [{ state: 'paused', reason: 'CONFLICTS' }, 'conflicts'], [{ error: 'DRIVE:db_relation_cardinality' }, 'conflicts'], [{ state: 'syncing' }, 'syncing'], [{ state: 'error', error: 'DRIVE:integrity' }, 'error'], [{ verified: 0 }, 'waiting']]) assert.equal(driveVisualState({ ...connected, ...change }), expected)
  assert.equal(driveVisualState({ ...connected, connected: false }), 'local')
})
test('grouping the preference UI preserves every existing policy control exactly once', () => {
  const keys = drivePreferenceGroups.flatMap(group => group.keys)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual([...keys].sort(), [...driveSettingKeys].sort())
})

test('untrusted sync timestamps cannot crash the account dialog', () => {
  for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(driveTimestamp(value), null)
  assert.equal(driveTimestamp(1000)?.toISOString(), '1970-01-01T00:00:01.000Z')
})
