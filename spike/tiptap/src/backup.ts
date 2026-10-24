import { allFiles, clearFiles, putRecord } from './attachments'
import { toMarkdown } from './markdown'
import { frontMatter } from './meta'
import type { Page, PageRepo } from './repo'
import { t } from './i18n'

const FORMAT = 'notes-backup'

export function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const toBase64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1] ?? '')
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })

const fromBase64 = (b64: string, type: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

const dataUri = async (src: string) => {
  if (!src.startsWith('att:')) return src
  const f = (await allFiles()).find((x) => x.id === src.slice(4))
  return f ? `data:${f.type};base64,${await toBase64(f.blob)}` : ''
}

export const pageToMarkdown = async (p: Page) => frontMatter(p) + (await toMarkdown(p.title, p.content, dataUri))

/** Full backup as one JSON file (pages incl. trash + every attachment). */
export async function buildBackup(repo: PageRepo): Promise<Blob> {
  const files = await Promise.all(
    (await allFiles()).map(async (f) => ({ id: f.id, type: f.type, name: f.name, size: f.size, data: await toBase64(f.blob) })),
  )
  const data = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), pages: repo.dump(), files }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

export class BackupError extends Error {}

/** Validates first, then replaces everything. Nothing is touched if validation fails. */
export async function restoreBackup(repo: PageRepo, text: string): Promise<{ pages: number; files: number }> {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupError(t('Not a valid JSON file.'))
  }
  if (data?.format !== FORMAT || data.version !== 1 || !Array.isArray(data.pages) || !Array.isArray(data.files))
    throw new BackupError(t('This is not a backup of this app, or its version is not supported.'))
  const ids = new Set<string>()
  for (const p of data.pages) {
    if (typeof p?.id !== 'string' || typeof p.title !== 'string' || !p.content || ids.has(p.id))
      throw new BackupError(t('The page structure is corrupted.'))
    ids.add(p.id)
  }
  for (const p of data.pages) if (p.parentId && !ids.has(p.parentId)) throw new BackupError(t('A page has no parent.'))

  await clearFiles()
  for (const f of data.files) await putRecord({ id: f.id, type: f.type, name: f.name, size: f.size, blob: fromBase64(f.data, f.type) })
  repo.restore(data.pages)
  return { pages: data.pages.length, files: data.files.length }
}
