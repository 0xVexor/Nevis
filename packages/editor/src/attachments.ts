// Attachments as the editor sees them (ROADMAP M9). The editor package knows nothing about stores or the network: the app gives it an
// `AttachmentsPort`. Bytes are shown through object URLs the editor makes itself from the bytes it gets, never from a URL on the server:
// a file a person (or someone they share with) attached is DATA, so what is drawn is decided here by looking at the bytes.
import type { Editor } from '@tiptap/core'
import { isBlobHash } from '@nevis/schema'
import { optionsOf } from './options'
import { S } from './strings'

export interface AttachmentRef { blob: string; mime: string; size: number; name: string }

export class AttachmentError extends Error {
  readonly code: 'too_large' | 'storage_full' | 'failed'
  constructor(code: 'too_large' | 'storage_full' | 'failed', message: string) { super(message); this.code = code }
}

export interface AttachmentsPort {
  /** the largest file the person may attach (the server's limit as the app knows it) */
  maxBytes: number
  /** Keeps the file on this device and returns what the node needs. The bytes sync later, in the background. Throws AttachmentError. */
  add(file: Blob, name: string, mime: string): Promise<AttachmentRef>
  /** The bytes: from this device, else from the server. null = not available now (not synced yet, or offline). */
  open(hash: string, mime: string): Promise<Blob | null>
  /** Called when bytes may have become available (a download finished, a sync round ended). Returns the unsubscribe. */
  subscribe?(cb: () => void): () => void
}

/** The raster formats an <img> may show. SVG is NOT one of them (it can carry script and is shown as a file), nor is anything else. */
export function sniffImage(head: Uint8Array): string {
  const is = (...b: number[]) => b.every((v, i) => head[i] === v)
  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (is(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (is(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp'
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70 && (String.fromCharCode(...head.subarray(8, 12)) === 'avif' || String.fromCharCode(...head.subarray(8, 12)) === 'avis')) return 'image/avif'
  return ''
}
export const sniffBlob = async (b: Blob): Promise<string> => sniffImage(new Uint8Array(await b.slice(0, 16).arrayBuffer()))

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Shows a person why a file was not attached. */
export function explain(editor: Editor, e: unknown): void {
  const notify = optionsOf(editor).notify
  if (e instanceof AttachmentError) notify?.(e.code === 'too_large' ? S.attachTooLarge : e.code === 'storage_full' ? S.attachStorageFull : S.attachFailed)
  else notify?.(S.attachFailed)
}

/** Reads the bytes of an attachment, waiting while they are not there yet (a page can arrive before its files). Calls `show` with the
 *  bytes as soon as they are available, or `missing` while they are not; stops with the returned function. */
export function whenAvailable(editor: Editor, hash: string, mime: string, show: (b: Blob) => void, missing: () => void): () => void {
  const port = optionsOf(editor).attachments
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = 2000
  let off: (() => void) | undefined
  async function tryOnce() {
    if (stopped) return
    if (timer) { clearTimeout(timer); timer = null }
    let b: Blob | null = null
    try { b = isBlobHash(hash) && port ? await port.open(hash, mime) : null } catch { b = null }
    if (stopped) return
    if (b) { stopped = true; off?.(); show(b); return } // found: no more polling, no more redrawing on every sync round
    missing()
    timer = setTimeout(() => { delay = Math.min(delay * 2, 30_000); void tryOnce() }, delay)
  }
  off = port?.subscribe?.(() => void tryOnce())
  void tryOnce()
  return () => { stopped = true; if (timer) clearTimeout(timer); off?.() }
}
