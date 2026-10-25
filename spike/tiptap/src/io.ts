import { Editor } from '@tiptap/core'
import { extensions } from './editor/extensions'
import { markdownToHtml } from './editor/markdownPaste'
import { toMarkdown } from './markdown'
import { allFiles, putFile } from './attachments'
import { normalizeFa } from './normalize'
import { STATUS, addTag, frontMatter } from './meta'
import { repo } from './store'
import { makeZip, type ZipEntry } from './zip'
import type { Page, PageStatus } from './repo'
import { t } from './i18n'


/** HTML -> ProseMirror JSON using the real schema, without mounting anything. */
function htmlToDoc(html: string): any {
  const ed = new Editor({ extensions, content: html })
  const json = ed.getJSON()
  ed.destroy()
  return json
}

/** Opens a native file picker and resolves with the chosen files ([] if cancelled). */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve([...(input.files ?? [])])
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

/** Folder picker: every file below the chosen folder, each with `webkitRelativePath`. */
export function pickDirectory(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.onchange = () => resolve([...(input.files ?? [])])
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

// ───────────── Markdown parsing helpers ─────────────

interface Meta {
  title?: string
  tags: string[]
  status?: PageStatus
  aliases: string[]
}

const unquote = (s?: string) => (s ?? '').trim().replace(/^["']|["']$/g, '').trim()

/** `key: [a, b]`, `key: a, b` and the block form (`key:` followed by `- a` lines). */
function yamlList(yaml: string, key: string): string[] {
  const m = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return []
  const inline = m[1].trim()
  if (inline) return inline.replace(/^\[|\]$/g, '').split(/[,،]/).map(unquote).filter(Boolean)
  const block = yaml.slice(m.index! + m[0].length).match(/^(?:\r?\n[ \t]*-[ \t]+.+)+/)
  return block ? block[0].split(/\r?\n/).map((l) => unquote(l.replace(/^[ \t]*-[ \t]+/, ''))).filter(Boolean) : []
}

function parseFrontMatter(text: string): { meta: Meta; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const meta: Meta = { tags: [], aliases: [] }
  if (!m) return { meta, body: text }
  const yaml = m[1]
  meta.title = unquote(yaml.match(/^title:[ \t]*(.+?)[ \t]*$/m)?.[1]) || undefined
  for (const t of [...yamlList(yaml, 'tags'), ...yamlList(yaml, 'tag')]) meta.tags = addTag(meta.tags, t)
  meta.aliases = [...yamlList(yaml, 'aliases'), ...yamlList(yaml, 'alias')]
  const st = unquote(yaml.match(/^status:[ \t]*(.+?)[ \t]*$/m)?.[1]).toLowerCase()
  if (st in STATUS) meta.status = st as PageStatus
  return { meta, body: text.slice(m[0].length) }
}

/** Runs `fn` on the text outside code fences / inline code only. */
function outsideCode(md: string, fn: (s: string) => string): string {
  return md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('')
}

/** `#tag` / `#a/b` written in the text (Obsidian style); headings (`# x`) and `#123` do not count. */
function inlineTags(md: string): string[] {
  const out: string[] = []
  outsideCode(md, (s) => {
    for (const m of s.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) if (!/^\d+$/.test(m[2])) out.push(m[2])
    return s
  })
  return out
}

async function replaceAsync(s: string, re: RegExp, fn: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
  const parts: string[] = []
  let last = 0
  for (const m of s.matchAll(re)) {
    parts.push(s.slice(last, m.index), await fn(m))
    last = m.index! + m[0].length
  }
  parts.push(s.slice(last))
  return parts.join('')
}

/**
 * Obsidian dialect -> what the Markdown importer understands:
 * `%%comments%%` dropped, `![[img.png]]` -> image, `![[Note]]` -> link, `[[Note|alias]]`, `[[Note#Heading]]`, `[[dir/Note]]` -> `[[Note]]`.
 */
async function fromObsidian(md: string, embed: (name: string) => Promise<string | null>): Promise<string> {
  const segs = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
  for (let i = 0; i < segs.length; i += 2) {
    let s = segs[i].replace(/%%[\s\S]*?%%/g, '')
    s = await replaceAsync(s, /!\[\[([^\]\n]+?)\]\]/g, async (m) => {
      const name = m[1].split('|')[0].split('#')[0].trim()
      const id = await embed(name)
      return id ? `![${name}](att:${id})` : `[[${name.replace(/\.md$/i, '')}]]`
    })
    s = s.replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner: string) => {
      const base = inner.split('|')[0].split('#')[0].trim().split('/').pop()!.replace(/\.md$/i, '')
      return base ? `[[${base}]]` : ''
    })
    segs[i] = s
  }
  return segs.join('')
}

/** `[[Title]]` text -> pageLink nodes when a page with that title exists. */
function linkify(node: any, titles: Map<string, string>): any {
  if (!node.content) return node
  const out: any[] = []
  for (const c of node.content) {
    if (c.type !== 'text' || !c.text.includes('[[')) {
      out.push(linkify(c, titles))
      continue
    }
    let rest: string = c.text
    for (let m = rest.match(/\[\[([^\]]+)\]\]/); m; m = rest.match(/\[\[([^\]]+)\]\]/)) {
      const id = titles.get(normalizeFa(m[1]).trim())
      const before = rest.slice(0, m.index!)
      if (!id) {
        out.push({ ...c, text: before + m[0] })
      } else {
        if (before) out.push({ ...c, text: before })
        out.push({ type: 'pageLink', attrs: { id } })
      }
      rest = rest.slice(m.index! + m[0].length)
    }
    if (rest) out.push({ ...c, text: rest })
  }
  // adjacent plain text from unresolved links may be split: merge for tidiness
  const merged: any[] = []
  for (const n of out) {
    const last = merged[merged.length - 1]
    if (last?.type === 'text' && n.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(n.marks)) last.text += n.text
    else merged.push(n)
  }
  return { ...node, content: merged }
}

const titleMap = (extra: [string, string][] = []) => {
  const m = new Map<string, string>()
  for (const [k, v] of extra) if (!m.has(normalizeFa(k).trim())) m.set(normalizeFa(k).trim(), v)
  for (const p of repo.pagesOnly()) if (!m.has(normalizeFa(p.title).trim())) m.set(normalizeFa(p.title).trim(), p.id)
  return m
}

/** Markdown (already in our dialect) -> ProseMirror doc; `img` may rewrite image sources (stored files, data: URIs). */
async function markdownToDoc(md: string, img: (src: string) => Promise<string | null>): Promise<any> {
  const dom = new DOMParser().parseFromString(markdownToHtml(md), 'text/html')
  for (const el of Array.from(dom.querySelectorAll('img'))) {
    const src = el.getAttribute('src') ?? ''
    if (src.startsWith('att:')) continue
    const id = await img(src)
    if (id) el.setAttribute('src', `att:${id}`)
  }
  return htmlToDoc(dom.body.innerHTML)
}

const dataUriImage = async (src: string) =>
  src.startsWith('data:') ? putFile(await (await fetch(src)).blob(), '') : null

/** Imports .md files as new top-level pages (title/tags/status from the front matter, `[[links]]` resolved). */
export async function importMarkdown(files: File[]): Promise<Page[]> {
  const created: Page[] = []
  for (const f of files) {
    const { meta, body } = parseFrontMatter(await f.text())
    let title = meta.title ?? f.name.replace(/\.(md|markdown|txt)$/i, '')
    let md = body
    const h1 = md.match(/^\s*#\s+(.+?)\s*#*\s*(\r?\n|$)/)
    if (h1 && !meta.title) {
      title = h1[1]
      md = md.slice(h1[0].length)
    }
    const page = repo.create(null)
    repo.update(page.id, { title, ...(meta.tags.length ? { tags: meta.tags } : {}), ...(meta.status ? { status: meta.status } : {}), content: await markdownToDoc(md, dataUriImage) })
    created.push(page)
  }
  // second pass: now that every title exists, resolve [[links]] (also to pre-existing pages)
  const titles = titleMap()
  for (const p of created) repo.update(p.id, { content: linkify(repo.get(p.id)!.content, titles) }, { history: false })
  return created.map((p) => repo.get(p.id)!)
}

// ───────────── Obsidian vault import ─────────────

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i
const lower = (s: string) => s.toLowerCase()

interface VaultResult {
  vault: string
  pages: number
  folders: number
  images: number
  tags: number
  skipped: number // files that are neither notes nor images (pdf, canvas, …)
}

/**
 * Imports an Obsidian vault (or any folder of Markdown files) picked with `pickDirectory()`:
 * the folder tree becomes folders, notes become pages named after their file, `[[wikilinks]]` become page links,
 * `![[image.png]]` embeds become stored images, front-matter and `#inline` tags become tags.
 * `.obsidian`, `.trash` and every other dot-folder are ignored.
 */
export async function importVault(files: File[], onProgress?: (done: number, total: number) => void): Promise<VaultResult> {
  const withPath = files.map((f) => ({ f, parts: (f.webkitRelativePath || f.name).split('/') }))
  const vault = withPath[0]?.parts.length > 1 ? withPath[0].parts[0] : 'Vault'
  const inVault = withPath
    .map(({ f, parts }) => ({ f, path: parts.length > 1 ? parts.slice(1) : parts }))
    .filter((x) => !x.path.some((seg) => seg.startsWith('.')))

  const notes = inVault.filter((x) => /\.md$/i.test(x.path.at(-1)!)).sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), 'fa', { numeric: true }))
  const images = new Map<string, File>() // by lower-cased relative path and by file name
  for (const x of inVault) {
    if (!IMAGE.test(x.path.at(-1)!)) continue
    images.set(lower(x.path.join('/')), x.f)
    if (!images.has(lower(x.path.at(-1)!))) images.set(lower(x.path.at(-1)!), x.f)
  }
  const result: VaultResult = { vault, pages: 0, folders: 1, images: 0, tags: 0, skipped: inVault.length - notes.length - new Set(inVault.filter((x) => IMAGE.test(x.path.at(-1)!)).map((x) => x.f)).size }

  // work in slices of ~12 ms and then let the UI draw, so a big vault imports quickly and the app stays responsive meanwhile
  let sliceAt = performance.now()
  const breathe = async () => {
    if (performance.now() - sliceAt < 12) return
    await new Promise((r) => setTimeout(r))
    sliceAt = performance.now()
  }

  const root = repo.create(null, 'folder')
  repo.update(root.id, { title: vault })
  const folders = new Map<string, string>([['', root.id]])
  const folderFor = (dir: string[]): string => {
    const key = dir.join('/')
    const hit = folders.get(key)
    if (hit) return hit
    const parent = folderFor(dir.slice(0, -1))
    const f = repo.create(parent, 'folder')
    repo.update(f.id, { title: dir.at(-1)! })
    folders.set(key, f.id)
    result.folders++
    return f.id
  }

  const stored = new Map<File, string>()
  const storeImage = async (f: File) => {
    let id = stored.get(f)
    if (!id) (id = await putFile(f, f.name), stored.set(f, id), result.images++)
    return id
  }
  const aliasOf: [string, string][] = []
  const made: Page[] = []

  for (let i = 0; i < notes.length; i++) {
    const { f, path } = notes[i]
    const dir = path.slice(0, -1)
    const { meta, body } = parseFrontMatter(await f.text())
    const title = meta.title ?? path.at(-1)!.replace(/\.md$/i, '')
    // Obsidian shows the file name as the title; a first line "# Same Title" would just repeat it
    let md = body.replace(new RegExp(`^\\s*#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\r?\\n`), '')
    let tags = meta.tags
    for (const t of inlineTags(md)) tags = addTag(tags, t)
    md = await fromObsidian(md, async (name) => {
      const f2 = images.get(lower(name)) ?? images.get(lower([...dir, name].join('/')))
      return f2 ? storeImage(f2) : null
    })
    const doc = await markdownToDoc(md, async (src) => {
      if (src.startsWith('data:')) return dataUriImage(src)
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null // http(s):, mailto:… stay as they are
      let rel = src
      try {
        rel = decodeURIComponent(src)
      } catch {
        /* keep as written */
      }
      const f2 = images.get(lower([...dir, rel].join('/')).replace(/[^/]+\/\.\.\//g, '')) ?? images.get(lower(rel)) ?? images.get(lower(rel.split('/').pop()!))
      return f2 ? storeImage(f2) : null
    })
    const page = repo.create(folderFor(dir))
    repo.update(page.id, { title, content: doc, ...(tags.length ? { tags } : {}), ...(meta.status ? { status: meta.status } : {}) })
    for (const a of meta.aliases) aliasOf.push([a, page.id])
    made.push(page)
    result.pages++
    result.tags += tags.length
    onProgress?.(i + 1, notes.length)
    await breathe()
  }

  // second pass: every title (and alias) exists now, so [[links]] can be resolved, also to older pages
  // (no history entries: the page was imported a moment ago, a copy of every note would only double the writes)
  const titles = titleMap(aliasOf)
  for (let i = 0; i < made.length; i++) {
    const p = made[i]
    repo.update(p.id, { content: linkify(repo.get(p.id)!.content, titles) }, { history: false })
    await breathe()
  }
  return result
}

// ───────────── export ─────────────

const safeName = (s: string) =>
  (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80)) || t('Untitled')
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }

export interface MarkdownTree {
  files: { path: string; text: string }[]
  assets: { id: string; ext: string }[] // attachments used by the pages, stored as assets/<id>.<ext>
}

/** Every page as Markdown, laid out as folders that mirror the page tree. `typeOf` gives the mime type of an attachment (undefined = missing). */
export async function buildMarkdownTree(typeOf: (id: string) => string | undefined): Promise<MarkdownTree> {
  const pages = repo.list()
  const used = new Map<string, string>()
  const taken = new Set<string>()
  const files: MarkdownTree['files'] = []

  const place = async (p: Page, dir: string[]) => {
    let name = safeName(p.title)
    for (let n = 2; taken.has([...dir, name].join('/').toLowerCase()); n++) name = `${safeName(p.title)} (${n})`
    taken.add([...dir, name].join('/').toLowerCase())

    if (p.kind === 'folder') {
      // a folder is just a directory: its children are placed inside it
      for (const c of pages.filter((x) => x.parentId === p.id).sort((x, y) => x.sort - y.sort)) await place(c, [...dir, name])
      return
    }
    const doc = typeof p.content === 'string' ? htmlToDoc(p.content) : p.content
    const up = '../'.repeat(dir.length)
    const md = await toMarkdown(p.title, doc, (src) => {
      if (!src.startsWith('att:')) return src
      const id = src.slice(4)
      const type = typeOf(id)
      if (type === undefined) return ''
      const ext = EXT[type] ?? 'bin'
      used.set(id, ext)
      return `${up}assets/${id}.${ext}`
    })
    files.push({ path: [...dir, `${name}.md`].join('/'), text: frontMatter(p) + md })
    for (const c of pages.filter((x) => x.parentId === p.id).sort((a, b) => a.sort - b.sort)) await place(c, [...dir, name])
  }
  for (const r of pages.filter((p) => !p.parentId).sort((a, b) => a.sort - b.sort)) await place(r, [])
  return { files, assets: [...used].map(([id, ext]) => ({ id, ext })) }
}

/** The zip download: the Markdown tree plus the image files. */
export async function exportAllZip(): Promise<{ blob: Blob; pages: number; files: number }> {
  const all = new Map((await allFiles()).map((f) => [f.id, f]))
  const tree = await buildMarkdownTree((id) => all.get(id)?.type)
  const enc = new TextEncoder()
  const entries: ZipEntry[] = tree.files.map((f) => ({ path: f.path, data: enc.encode(f.text) }))
  for (const a of tree.assets) entries.push({ path: `assets/${a.id}.${a.ext}`, data: new Uint8Array(await all.get(a.id)!.blob.arrayBuffer()) })
  return { blob: makeZip(entries), pages: tree.files.length, files: tree.assets.length }
}
