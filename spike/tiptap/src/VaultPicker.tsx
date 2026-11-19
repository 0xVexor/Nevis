import { open } from '@tauri-apps/plugin-dialog'
import { vaultAdd, vaultCreate, vaultForget, vaultList, vaultLocate, vaultOpen } from './db'
import { explain } from './vaultErrors'
import { Onboarding, type WorkspaceServices } from './onboarding/Onboarding'
import { markFirstNote } from './onboarding/FirstNoteStart'
import { SYNC_ENABLED } from './releaseFeatures'
import { accountLogin, accountLogout, accountRegister, accountStatus, cloudDelete, cloudDownload, cloudPurge, cloudRestore, cloudTrashed, cloudVaults, saveRecoveryKeyFile, serverHealth, syncSet } from './sync/client'

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
  // sync is a desktop feature and can be switched off for a release; without it the start flow only knows local folders
  cloud: SYNC_ENABLED
    ? {
        status: accountStatus,
        login: accountLogin,
        register: accountRegister,
        health: serverHealth,
        vaults: cloudVaults,
        delete: cloudDelete, // no workspace is open here, so there is no sync of this device to stop
        trashed: cloudTrashed,
        restore: cloudRestore,
        purge: (id) => cloudPurge(id),
        download: cloudDownload,
        logout: accountLogout,
        saveKey: saveRecoveryKeyFile,
        copyKey: (key) => navigator.clipboard.writeText(key),
        // the workspace that was just created is the open one, which is what sync_set acts on
        enableSync: () => syncSet(true),
      }
    : undefined,
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
