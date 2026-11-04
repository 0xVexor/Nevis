// Reads a backup file and checks all of it, without writing anything. The result is what the review dialog shows and
// what the restore applies, so a file that passes here cannot fail halfway through a restore because of its own content.
import { t } from '../i18n'
import { BackupError, FORMAT, STORES, TAURI_FORMAT, digest, fromBase64 } from './format'

export interface BackupSummary {
  /** `vault`: a desktop vault backup. `web`: a browser backup (v1 pages only, v2 everything). */
  kind: 'vault' | 'web'
  version: number
  createdAt?: number
  name?: string
  pages: number
  folders: number
  trashed: number
  files: number
  bytes: number
}

export interface PreparedFile {
  id: string
  type: string
  name: string
  size: number
  blob: Blob
}

export interface BackupPlan {
  summary: BackupSummary
  // oxlint-disable-next-line typescript/no-explicit-any -- the parsed backup file, validated field by field in inspectBackup
  data: any
  prepared: PreparedFile[]
}

const dateOf = (v: unknown) => {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Parses and validates. Throws `BackupError` with a message that says what is wrong. */
export async function inspectBackup(text: string): Promise<BackupPlan> {
  // oxlint-disable-next-line typescript/no-explicit-any -- untrusted JSON.parse result, validated below
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupError(t('Not a valid JSON file.'))
  }
  const bytes = text.length

  if ((data?.format === TAURI_FORMAT || data?.format === "noviq-vault-backup") && data.version === 2) {
    const names = Object.keys(data.entries ?? {})
    if (!data.entries || typeof data.entries !== 'object' || !names.length) throw new BackupError(t('The backup records are corrupted.'))
    for (const n of names) {
      const e = data.entries[n]
      if (typeof e?.data !== 'string' || typeof e.sha256 !== 'string') throw new BackupError(t('The backup records are corrupted.'))
    }
    const pageFiles = names.filter((n) => /^pages\/[^/]+\.json$/.test(n))
    let folders = 0
    let trashed = 0
    for (const n of pageFiles) {
      try {
        const p = JSON.parse(atob(data.entries[n].data))
        if (p?.kind === 'folder') folders++
        if (p?.deletedAt) trashed++
      } catch {
        /* counted as a page; the vault validates it when it opens */
      }
    }
    const files = names.filter((n) => /^files\/[^/]+\/[^/.]+$/.test(n)).length
    return {
      summary: {
        kind: 'vault',
        version: 2,
        createdAt: dateOf(data.created_at),
        name: typeof data.name === 'string' ? data.name : undefined,
        pages: pageFiles.length - folders,
        folders,
        trashed,
        files,
        bytes,
      },
      data,
      prepared: [],
    }
  }

  if (data?.format !== FORMAT || ![1, 2].includes(data.version) || !Array.isArray(data.pages) || !Array.isArray(data.files))
    throw new BackupError(t('This is not a backup of this app, or its version is not supported.'))
  const ids = new Set<string>()
  for (const p of data.pages) {
    if (typeof p?.id !== 'string' || typeof p.title !== 'string' || !p.content || ids.has(p.id)) throw new BackupError(t('The page structure is corrupted.'))
    ids.add(p.id)
  }
  for (const p of data.pages) if (p.parentId && !ids.has(p.parentId)) throw new BackupError(t('A page has no parent.'))

  // Check every byte before anything is written; the files are decoded here so the restore only has to store them.
  const prepared: PreparedFile[] = []
  const fileIds = new Set<string>()
  for (const f of data.files) {
    if (typeof f.id !== 'string' || !/^[a-f0-9]{64}$/.test(f.id) || fileIds.has(f.id) || typeof f.data !== 'string' || typeof f.type !== 'string' || typeof f.name !== 'string')
      throw new BackupError(t('The attachment structure is corrupted.'))
    const blob = fromBase64(f.data, f.type)
    if (blob.size !== f.size || (await digest(await blob.arrayBuffer())) !== f.id) throw new BackupError(t('An attachment failed verification.'))
    fileIds.add(f.id)
    prepared.push({ id: f.id, type: f.type, name: f.name, size: f.size, blob })
  }

  if (data.version === 2) {
    if (typeof data.recordsHash !== 'string' || (await digest(new TextEncoder().encode(JSON.stringify(data.records)))) !== data.recordsHash)
      throw new BackupError(t('The backup records are corrupted.'))
    if (!data.records || Object.keys(data.records).some((k) => !STORES.includes(k)) || STORES.some((k) => !Array.isArray(data.records[k])))
      throw new BackupError(t('The backup records are corrupted.'))
    for (const rows of Object.values(data.records) as { key: IDBValidKey; value: unknown }[][]) {
      const keys = new Set<string>()
      for (const row of rows) {
        const key = JSON.stringify(row.key)
        if (row.value === undefined || row.key === undefined || keys.has(key)) throw new BackupError(t('The backup records are corrupted.'))
        keys.add(key)
      }
    }
    if (JSON.stringify(data.records.pages.map((r: { value: unknown }) => r.value)) !== JSON.stringify(data.pages)) {
      // The canonical store controls page identity; redundant display pages must describe the same set.
      const stored = new Set(data.records.pages.map((r: { value: { id: string } }) => r.value?.id))
      if (stored.size !== data.pages.length || data.pages.some((p: { id: string }) => !stored.has(p.id))) throw new BackupError(t('The backup records are corrupted.'))
    }
  }

  const folders = data.pages.filter((p: { kind?: string }) => p.kind === 'folder').length
  const trashed = data.pages.filter((p: { deletedAt?: unknown }) => p.deletedAt).length
  return { summary: { kind: 'web', version: data.version, createdAt: dateOf(data.createdAt), pages: data.pages.length - folders, folders, trashed, files: data.files.length, bytes }, data, prepared }
}
