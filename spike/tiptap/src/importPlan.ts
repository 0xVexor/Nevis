// What the person picked or dropped, looked at before anything is written: what kind of thing it is, how much is in it
// and what will not come along. `runImport` then does the work and reports each file that failed, not only "failed".
import { repo } from './store'
import { importMarkdown, importVault } from './io'
import { t } from './i18n'
import { readZip } from './zip'
import { BackupError, inspectBackup, type BackupPlan } from './backup'
import { isTauri } from './db'

export type ImportKind = 'markdown' | 'vault' | 'backup'

export interface ImportReview {
  kind: ImportKind
  /** What the person picked: the folder, the zip or the file name. */
  name: string
  pages: number
  folders: number
  images: number
  /** Files that will be left out (PDFs, canvases, hidden folders…), by extension. */
  skipped: Record<string, number>
  /** Things worth knowing before importing; already translated. */
  notes: string[]
  /** Files that can not be read at all; already translated, one per file. */
  problems: { name: string; reason: string }[]
  files: File[]
  backup?: BackupPlan
}

export interface ImportOutcome {
  pages: number
  folders: number
  images: number
  errors: { name: string; reason: string }[]
  /** The first page that was created, to open it. */
  first?: string
}

const NOTE = /\.(md|markdown|txt)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i
const extOf = (n: string) => (n.includes('.') ? n.split('.').pop()!.toLowerCase() : '')
const hidden = (parts: string[]) => parts.some((s) => s.startsWith('.'))

/** A zip becomes the same list of files a picked folder gives, rooted at the zip's name. */
async function unzip(file: File): Promise<File[]> {
  const name = file.name.replace(/\.zip$/i, '')
  return (await readZip(await file.arrayBuffer())).map((e) => {
    const f = new File([e.data as BlobPart], e.path.split('/').pop()!)
    Object.defineProperty(f, 'webkitRelativePath', { value: `${name}/${e.path}` })
    return f
  })
}

const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : t('The file could not be read.'))

/** Looks at the picked files. Never writes. Throws only for a backup file, with a message that says what is wrong. */
export async function reviewImport(picked: File[]): Promise<ImportReview> {
  const review: ImportReview = { kind: 'markdown', name: '', pages: 0, folders: 0, images: 0, skipped: {}, notes: [], problems: [], files: [] }
  const single = picked.length === 1 ? picked[0] : undefined

  if (single && /\.json$/i.test(single.name)) {
    const backup = await inspectBackup(await single.text())
    // a desktop backup is a copy of the vault's files; the browser version keeps its notes in a different store and cannot take it
    if (backup.summary.kind === 'vault' && !isTauri) throw new BackupError(t('This backup was made by the Nevis desktop app. Restore it in the desktop app.'))
    return { ...review, kind: 'backup', name: single.name, pages: backup.summary.pages, folders: backup.summary.folders, images: backup.summary.files, backup }
  }

  let files = picked
  if (single && /\.zip$/i.test(single.name)) {
    try {
      files = await unzip(single)
    } catch {
      review.problems.push({ name: single.name, reason: t('This is not a zip file, or it is damaged.') })
      return { ...review, name: single.name }
    }
    review.kind = 'vault'
    review.name = single.name
  } else if (picked.some((f) => f.webkitRelativePath)) {
    review.kind = 'vault'
    review.name = picked[0].webkitRelativePath.split('/')[0]
  } else {
    review.name = picked.length === 1 ? picked[0].name : t('{n} files', { n: picked.length })
  }

  const inside = files
    .map((f) => ({ f, parts: (f.webkitRelativePath || f.name).split('/') }))
    .filter((x) => !(review.kind === 'vault' && hidden(x.parts.slice(1))))
  const notes = inside.filter((x) => NOTE.test(x.parts.at(-1)!) && (review.kind === 'markdown' || /\.md$/i.test(x.parts.at(-1)!)))
  for (const x of inside) {
    const name = x.parts.at(-1)!
    if (notes.includes(x)) continue
    if (review.kind === 'vault' && IMAGE.test(name)) review.images++
    else review.skipped[extOf(name) || t('no extension')] = (review.skipped[extOf(name) || t('no extension')] ?? 0) + 1
  }
  review.pages = notes.length
  if (review.kind === 'vault') {
    const dirs = new Set<string>()
    for (const x of notes) for (let i = 1; i < x.parts.length - 1; i++) dirs.add(x.parts.slice(1, i + 1).join('/'))
    review.folders = dirs.size + 1
  }
  for (const x of notes) if (!x.f.size) review.notes.push(t('“{name}” is empty.', { name: x.parts.at(-1)! }))
  if (review.kind === 'markdown' && !notes.length) review.problems.push({ name: review.name, reason: t('There are no Markdown files here.') })
  if (review.kind === 'vault' && !notes.length) review.problems.push({ name: review.name, reason: t('There are no Markdown notes in this folder.') })
  review.files = review.kind === 'markdown' ? notes.map((x) => x.f) : files
  return review
}

/** Does the import. Pages are added, nothing that exists is replaced. `progress` gets (done, total). */
export async function runImport(review: ImportReview, progress?: (done: number, total: number) => void): Promise<ImportOutcome> {
  const errors: ImportOutcome['errors'] = []
  const onError = (name: string, e: unknown) => errors.push({ name, reason: reasonOf(e) })
  if (review.kind === 'markdown') {
    const made = await importMarkdown(review.files, onError)
    return { pages: made.length, folders: 0, images: 0, errors, first: made[0]?.id }
  }
  const r = await importVault(review.files, progress, onError)
  const first = repo.list().find((p) => p.kind === 'folder' && p.title === r.vault && !p.parentId)
  return { pages: r.pages, folders: r.folders, images: r.images, errors, first: first?.id }
}
