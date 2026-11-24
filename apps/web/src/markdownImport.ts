import { cleanPastedHtml, markdownToHtml, sniffImage, type AttachmentRef } from '@nevis/editor'
import { schema, type PMJson } from '@nevis/schema'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { strFromU8, unzipSync } from 'fflate'
import type { Workspace } from './workspace'

interface Note { path: string; title: string; html: string }
export type PreparedImport = { kind: 'bundle'; bytes: Uint8Array } | { kind: 'notes'; notes: Note[]; files: Record<string, Uint8Array> }
const textFile = /\.(md|markdown|txt)$/i
const maxBytes = 100 * 1024 * 1024

/** Prepare before creating a workspace, so invalid files do not leave an empty workspace behind. */
export async function prepareImport(file: File): Promise<PreparedImport> {
  if (file.size > maxBytes) throw new Error('File is too large')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (/\.zip$/i.test(file.name)) {
    // First inspect the manifest only. Bundle validation remains the responsibility of importBundle.
    const manifest = unzipSync(bytes, { filter: f => f.name === 'manifest.json' && f.originalSize <= 1024 * 1024 })['manifest.json']
    let bundle = /\.nevis\.zip$/i.test(file.name)
    if (manifest) {
      try { bundle ||= (JSON.parse(strFromU8(manifest)) as { format?: string }).format === 'nevis-bundle' } catch { /* not a bundle manifest */ }
    }
    if (bundle) return { kind: 'bundle', bytes }
    let total = 0
    const entries = unzipSync(bytes, { filter: f => {
      if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || f.name.split('/').at(-1) === '.DS_Store') return false
      total += f.originalSize
      if (total > maxBytes) throw new Error('Archive is too large')
      return true
    } })
    const notes = Object.entries(entries).filter(([path]) => textFile.test(path)).map(([path, data]) => note(path, strFromU8(data)))
    if (!notes.length) throw new Error('No Markdown or text files found')
    return { kind: 'notes', notes, files: entries }
  }
  if (!textFile.test(file.name)) throw new Error('Unsupported file type')
  return { kind: 'notes', notes: [note(file.name, strFromU8(bytes))], files: {} }
}

function note(path: string, source: string): Note {
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid archive path')
  let title = parts.at(-1)!.replace(/\.(md|markdown|txt)$/i, '').replace(/--[0-9a-f]{8}$/i, '')
  let text = source.replace(/^\uFEFF/, '')
  if (!/\.txt$/i.test(path)) {
    // Recognize the front matter written by Nevis without interpreting arbitrary YAML.
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    if (front) {
      const match = front[1]!.match(/^title:\s*("(?:[^"\\]|\\.)*")\s*$/m)
      if (match) { try { title = JSON.parse(match[1]!) as string } catch { /* use filename */ } }
      text = text.slice(front[0].length).replace(/^<!--[^]*?-->\s*/, '')
    }
  }
  const html = /\.txt$/i.test(path)
    ? text.split(/\r?\n/).map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('')
    : markdownToHtml(text, false)
  return { path, title, html }
}

export async function importNotes(ws: Workspace, notes: Note[], files: Record<string, Uint8Array>): Promise<void> {
  const paths = new Map<string, string>()
  const attachments = new Map<string, AttachmentRef>()
  // A page and its children share the same filename stem in Nevis Markdown exports.
  const ordered = [...notes].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  for (const item of ordered) {
    const parts = item.path.split('/')
    let parent = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/')
      let id = paths.get(key)
      if (!id) { id = await ws.newFolder(parent, parts[i]!); paths.set(key, id) }
      parent = id
    }
    const id = await ws.newPage(parent, item.title)
    const doc = new DOMParser().parseFromString(item.html, 'text/html')
    const base = 'https://archive.invalid/' + parts.map(encodeURIComponent).join('/')
    for (const image of doc.querySelectorAll<HTMLImageElement>('img[src]')) {
      const source = image.getAttribute('src') ?? ''
      if (!source || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) continue
      let path: string
      try { path = decodeURIComponent(new URL(source, base).pathname).slice(1) } catch { continue }
      const bytes = files[path]
      if (!(bytes instanceof Uint8Array)) continue
      const mime = sniffImage(bytes.subarray(0, 16))
      if (!mime) continue
      let attached = attachments.get(path)
      if (!attached) {
        attached = await ws.rt.attachments.add(new Blob([new Uint8Array(bytes)], { type: mime }), path.split('/').at(-1)!, mime)
        attachments.set(path, attached)
      }
      const figure = doc.createElement('figure')
      figure.dataset.type = 'image'
      for (const [key, value] of Object.entries({ ...attached, alt: image.alt, title: image.title })) figure.setAttribute('data-' + key, String(value))
      const paragraph = image.parentElement
      if (paragraph?.tagName === 'P' && paragraph.childNodes.length === 1) paragraph.replaceWith(figure)
      else image.replaceWith(figure)
    }
    const clean = new DOMParser().parseFromString(cleanPastedHtml(doc.body.innerHTML), 'text/html')
    await ws.writeBody(id, ProseMirrorDOMParser.fromSchema(schema).parse(clean.body).toJSON() as PMJson)
    paths.set(item.path.replace(/\.(md|markdown|txt)$/i, ''), id)
  }
}
