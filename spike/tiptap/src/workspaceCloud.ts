export interface RemoteWorkspace { id: string; name: string; folderId?: string; files?: number; bytes?: number }
export type WorkspaceCall = (command: string, args?: Record<string, unknown>) => Promise<unknown>
export async function listCloudWorkspaces(provider: string | undefined, call: WorkspaceCall): Promise<RemoteWorkspace[]> {
  return await (provider === 'drive' ? call('drive_action', { action: 'list', args: {} }) : call('cloud_vaults')) as RemoteWorkspace[]
}
export async function downloadCloudWorkspace(provider: string | undefined, vault: RemoteWorkspace, parent: string, call: WorkspaceCall): Promise<void> {
  if (provider === 'drive') {
    if (!vault.folderId) throw new Error('DRIVE:missing_folder')
    await call('drive_action', { action: 'download', args: { id: vault.id, name: vault.name, folderId: vault.folderId, parent } })
  } else await call('cloud_download', { id: vault.id, name: vault.name, parent })
}
export async function createDriveWorkspace(name: string, chooseParent: () => Promise<string | null>, call: WorkspaceCall): Promise<boolean> {
  const parent = await chooseParent()
  if (!parent) return false
  await call('drive_action', { action: 'create', args: { name, parent } })
  return true
}

/** No old editor/preference write may enter the newly activated workspace. */
export async function switchWorkspaceSafely(action: () => Promise<unknown>, lifecycle: { save: () => Promise<void>; freeze: () => void; thaw: () => void; opened: () => void }): Promise<void> {
  await lifecycle.save()
  lifecycle.freeze()
  try { await action() } catch (error) { lifecycle.thaw(); throw error }
  lifecycle.opened()
}
