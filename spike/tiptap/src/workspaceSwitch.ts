/** No old editor/preference write may enter the newly activated workspace. */
export async function switchWorkspaceSafely(action: () => Promise<unknown>, lifecycle: { save: () => Promise<void>; freeze: () => void; thaw: () => void; opened: () => void }): Promise<void> {
  await lifecycle.save()
  lifecycle.freeze()
  try { await action() } catch (error) { lifecycle.thaw(); throw error }
  lifecycle.opened()
}
