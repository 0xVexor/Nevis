// The desktop build keeps notes as files in a vault folder. A backup is the vault's own export, and a restore opens it as a
// new vault next to the current one, so nothing the person has is replaced.
import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'
import { BackupError, TAURI_FORMAT, digest, toBase64 } from './format'
import type { BackupPlan } from './inspect'

export const buildTauri = async () => new Blob([JSON.stringify(await invoke('vault_backup_export'))], { type: 'application/json' })

/** A browser-style backup (pages and files only) becomes the vault payload the desktop side restores. */
async function vaultPayload(plan: BackupPlan) {
  {
    const entries: Record<string, { data: string; sha256: string }> = {}
    const add = async (path: string, bytes: Uint8Array) => { entries[path] = { data: await toBase64(new Blob([bytes as BlobPart])), sha256: await digest(bytes as BufferSource) } }
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
    for (const p of plan.data.pages) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)) throw new BackupError(t('The page structure is corrupted.'))
      await add('pages/' + p.id + '.json', enc(p))
    }
    for (const f of plan.prepared) {
      const path = 'files/' + f.id.slice(0, 2) + '/' + f.id
      await add(path, new Uint8Array(await f.blob.arrayBuffer()))
      await add(path + '.json', enc({ id: f.id, type: f.type, name: f.name, size: f.size, addedAt: Date.now() }))
    }
    await add('.noviq/vault.json', enc({ format: 1, id: crypto.randomUUID(), name: 'Imported backup' }))
    return { format: TAURI_FORMAT, version: 2, name: 'Imported backup', created_at: Date.now(), entries }
  }
}

export async function applyTauri(plan: BackupPlan) {
  const data = plan.summary.kind === 'vault' ? plan.data : await vaultPayload(plan)
  return invoke<{ pages: number; files: number }>('vault_backup_restore', { data })
}
