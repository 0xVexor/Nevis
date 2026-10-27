import { Channel, invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { getSettings } from './settings'
import { createUpdateController, type AvailableUpdate, type UpdateProgress } from './updateController'
import { saveBeforeUpdate } from './updateSave'
import { repo } from './store'
import { freezeStorage, thawStorage } from './db'
import { peekDatabase } from './database/runtime'
import { prepareStorageTransition } from './storageTransition'

let resumeStorage: (() => void) | undefined

export const updates = createUpdateController({
  includePrerelease: () => getSettings().prereleaseUpdates === true,
  check: (includePrerelease) => invoke<AvailableUpdate | null>('updates_check', { includePrerelease }),
  download: (version, progress) => {
    const onProgress = new Channel<UpdateProgress>()
    onProgress.onmessage = progress
    return invoke('updates_download', { version, onProgress })
  },
  save: async () => {
    resumeStorage = await prepareStorageTransition({
      saveEditors: saveBeforeUpdate, repository: repo, coordinator: peekDatabase()?.coord,
      freeze: freezeStorage, thaw: thawStorage,
    })
  },
  install: async (version) => {
    try { await invoke('updates_install', { version }) }
    catch (error) { resumeStorage?.(); resumeStorage = undefined; throw error }
  },
})
export const useUpdates = () => useSyncExternalStore(updates.subscribe, updates.getSnapshot)
