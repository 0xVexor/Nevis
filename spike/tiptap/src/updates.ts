import { Channel, invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { getSettings } from './settings'
import { createUpdateController, type AvailableUpdate, type UpdateProgress } from './updateController'
import { saveBeforeUpdate } from './updateSave'
import { repo } from './store'
import { peekDatabase } from './database/runtime'

export const updates = createUpdateController({
  includePrerelease: () => getSettings().prereleaseUpdates === true,
  check: (includePrerelease) => invoke<AvailableUpdate | null>('updates_check', { includePrerelease }),
  download: (version, progress) => {
    const onProgress = new Channel<UpdateProgress>()
    onProgress.onmessage = progress
    return invoke('updates_download', { version, onProgress })
  },
  save: async () => {
    await saveBeforeUpdate()
    await peekDatabase()?.coord.flushed()
    await repo.flushBeforeUpdate()
  },
  install: (version) => invoke('updates_install', { version }),
})
export const useUpdates = () => useSyncExternalStore(updates.subscribe, updates.getSnapshot)
