import { repo } from './store'
import { saveBeforeUpdate } from './updateSave'
import { flushPreferences } from './sharedPreferences'

/** Writes everything that is still in memory (open editors, the page store, preferences) to the vault. */
export async function saveWorkspace() { await saveBeforeUpdate(); await repo.flushBeforeUpdate(); await flushPreferences() }
