import { open } from '@tauri-apps/plugin-dialog'
import { vaultAdd, vaultCreate, vaultForget, vaultList, vaultLocate, vaultOpen } from './db'
import { explain } from './vaultErrors'
import { Onboarding, type WorkspaceServices } from './onboarding/Onboarding'
import { markFirstNote } from './onboarding/FirstNoteStart'

const services: WorkspaceServices = {
  list: async () => (await vaultList()).vaults,
  pickFolder: async (title) => {
    const dir = await open({ directory: true, multiple: false, title })
    return typeof dir === 'string' ? dir : null
  },
  create: vaultCreate,
  add: vaultAdd,
  open: vaultOpen,
  locate: vaultLocate,
  forget: vaultForget,
  explain,
}

/** Shown when no vault is open: the first run, or after “All workspaces…”. The user always chooses where a vault lives. */
export function VaultPicker({ onOpened }: { onOpened: () => void }) {
  return (
    <Onboarding
      services={services}
      onOpened={(workspace) => {
        if (workspace.created) markFirstNote(workspace.name)
        onOpened()
      }}
    />
  )
}
