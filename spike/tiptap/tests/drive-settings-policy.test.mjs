import test from 'node:test'
import assert from 'node:assert/strict'
import { settingsPolicy, preserveDeviceSettings } from '../src/driveSettingsPolicy'
test('device-local font survives a fresh Vault pull while global theme changes', () => {
  const policy = settingsPolicy({ nevisDriveSyncPolicy: { schemaVersion: 1, fields: { fontSize: 'device-local', theme: 'global' } } })
  const next = JSON.parse(preserveDeviceSettings(JSON.stringify({ theme: 'dark' }), JSON.stringify({ theme: 'light', fontSize: 23 }), policy))
  assert.deepEqual(next, { theme: 'dark', fontSize: 23 })
})
test('untrusted policy fails closed and absent policy preserves legacy behavior', () => {
  assert.deepEqual(settingsPolicy(undefined), {})
  assert.throws(() => settingsPolicy({ nevisDriveSyncPolicy: { schemaVersion: 99, fields: {} } }))
  assert.throws(() => settingsPolicy({ nevisDriveSyncPolicy: { schemaVersion: 1, fields: { token: 'global' } } }))
  const incoming = '{"fontSize":18}'; assert.equal(preserveDeviceSettings(incoming, '{}', {}), incoming)
})
