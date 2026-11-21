// The one-way Markdown mirror (desktop, ADR-0009 §3). After changes (5 s of quiet) the files of the changed pages are rewritten in the chosen folder by
// Rust (atomic, only when the bytes differ); a page that was trashed or moved has its old file removed. The folder is NEVER read.
import type { Workspace } from './workspace'
import { invoke } from './desktop'

const QUIET_MS = 5000
const keyOf = (ws: string) => `nevis.mirror.${ws}`
export const mirrorFolder = (ws: string): string => { try { return localStorage.getItem(keyOf(ws)) ?? '' } catch { return '' } }
export const setMirrorFolder = (ws: string, dir: string) => { try { if (dir) localStorage.setItem(keyOf(ws), dir); else localStorage.removeItem(keyOf(ws)) } catch { /* a private window */ } }

export class Mirror {
  private paths = new Map<string, string>()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private all = true
  last = { written: 0, skipped: 0, removed: 0 }
  private readonly ws: Workspace
  readonly dir: string
  constructor(ws: Workspace, dir: string) { this.ws = ws; this.dir = dir }
  touch(ids?: string[]) { if (ids) for (const i of ids) this.dirty.add(i); else this.all = true; clearTimeout(this.timer); this.timer = setTimeout(() => void this.run().catch(() => undefined), QUIET_MS) }
  stop() { clearTimeout(this.timer) }
  /** Writes what changed now (also the first full write). */
  async run() {
    const pages = this.ws.data.pages.filter(p => p.type !== 'database')
    const live = new Set(pages.filter(p => !p.trashed).map(p => p.id))
    const todo = this.all ? [...live] : [...this.dirty].filter(i => live.has(i))
    this.all = false; this.dirty.clear()
    const files: [string, string][] = []
    const remove: string[] = []
    for (const id of todo) {
      const f = await this.ws.markdownOf(id)
      const old = this.paths.get(id)
      if (old && old !== f.path) remove.push(old)
      this.paths.set(id, f.path); files.push([f.path, f.text])
    }
    for (const [id, path] of [...this.paths]) if (!live.has(id)) { remove.push(path); this.paths.delete(id) }
    this.last = (await invoke('mirror_sync', { dir: this.dir, files, remove })) as typeof this.last
  }
}
