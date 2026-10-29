import test from 'node:test'
import assert from 'node:assert/strict'
import { listCloudWorkspaces, downloadCloudWorkspace, createDriveWorkspace, switchWorkspaceSafely } from '../src/workspaceCloud'
test('Drive startup discovery and download keep verified remote folder identity and never call the legacy server', async () => {
  const remote = { id: 'vault-id', name: 'Notes', folderId: 'verified-folder' }
  const calls = []
  const native = async (command, args) => { assert.equal(command, 'drive_action'); calls.push(args); if (args.action === 'list') return [remote] }
  const [vault] = await listCloudWorkspaces('drive', native)
  await downloadCloudWorkspace('drive', vault, '/local/parent', native)
  assert.deepEqual(calls, [{ action: 'list', args: {} }, { action: 'download', args: { ...remote, parent: '/local/parent' } }])
  await assert.rejects(downloadCloudWorkspace('drive', { id: 'bad', name: 'No folder' }, '/local', native), /missing_folder/)
  assert.equal(calls.length, 2)
})
test('cancelled folder choice creates nothing, while cloud setup failure is not reported as an opened workspace', async () => {
  const calls = []
  assert.equal(await createDriveWorkspace('Notes', async () => null, async (...args) => calls.push(args)), false)
  assert.equal(calls.length, 0)
  await assert.rejects(createDriveWorkspace('Notes', async () => '/local', async (command, args) => { calls.push([command, args]); throw new Error('DRIVE:network') }), /DRIVE:network/)
  assert.deepEqual(calls, [['drive_action', { action: 'create', args: { name: 'Notes', parent: '/local' } }]])
  assert.equal(await createDriveWorkspace('Notes', async () => '/local', async () => null), true)
})
test('legacy workspace discovery and downloads retain their existing commands', async () => {
  const calls = []
  const native = async (...args) => { calls.push(args); return [] }
  await listCloudWorkspaces('legacy', native)
  await downloadCloudWorkspace('legacy', { id: 'old', name: 'Legacy' }, '/parent', native)
  assert.deepEqual(calls, [['cloud_vaults'], ['cloud_download', { id: 'old', name: 'Legacy', parent: '/parent' }]])
})

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
