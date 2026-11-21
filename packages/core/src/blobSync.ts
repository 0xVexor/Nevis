// Attachment sync (ROADMAP M9): upload what this device holds and the server lacks, download on demand, gate the outbox, and tell the
// server what the workspace still refers to so that it may collect the rest. Everything the platform provides is a port (BlobStore,
// BlobNet, the Store), so this runs the same in Node tests, the web app and the desktop WebView.
import { parseEnvelope } from '@nevis/protocol'
import { hexNamesIn, sha256Hex, type BlobMeta, type BlobStore } from './blobs'
import { NetError, type OutboxGate } from './engine'
import type { OutboxRow, Store } from './store'

/** The server's blob endpoints, as BlobSync sees them. `httpBlobNet` is the real one. */
export interface BlobNet {
  /** stored: the file is complete on the server; otherwise `received` bytes of a half upload are there (0 = none) */
  head(ws: string, hash: string): Promise<{ stored: true; size: number } | { stored: false; received: number }>
  /** One piece of an upload. The last one (offset + length = total) makes the server check the whole hash. */
  put(ws: string, hash: string, piece: Blob, offset: number, total: number): Promise<{ complete: boolean; received: number }>
  /** Bytes start..end (inclusive) of a stored file, and its total size. 404 `no_such_blob` when the server does not have it. */
  get(ws: string, hash: string, start: number, end: number): Promise<{ data: Blob; total: number }>
  /** The hashes the client's workspace refers to; `cursor` is how far it has pulled (0 = a partial list: only ever keeps blobs). */
  reportRefs(ws: string, cursor: number, refs: string[]): Promise<{ applied: boolean }>
}

export interface BlobStatus {
  /** files here that the server does not have yet */
  pending: number
  uploading: boolean
  /** bytes sent / bytes of the file being sent */
  sent: number
  total: number
  /** '' | 'quota' (the account is full) | 'offline' | another server code: shown to the person; the local data is never touched */
  error: string
}

export interface BlobSyncOptions {
  ws: string
  blobs: BlobStore
  net: BlobNet
  /** upload piece size (default 2 MB) */
  pieceSize?: number
  /** how long a successful "the server still has it" check is trusted (default 60 s) */
  verifyTtlMs?: number
  now?: () => number
  /** status changed (progress, an error, a file finished) */
  onChange?: () => void
  /** a file finished uploading: the held ops may go now (the app kicks the sync) */
  onUploaded?: () => void
}

const DAY = 24 * 3600 * 1000

export class BlobSync implements OutboxGate {
  private readonly o: Required<Omit<BlobSyncOptions, 'onChange' | 'onUploaded'>> & Pick<BlobSyncOptions, 'onChange' | 'onUploaded'>
  private st: BlobStatus = { pending: 0, uploading: false, sent: 0, total: 0, error: '' }
  private uploadRun: Promise<void> | null = null
  private verified = new Map<string, number>()
  private downloads = new Map<string, Promise<Blob | undefined>>()
  /** hashes of ops that went through the gate since the last report: told to the server as references (a list that only keeps blobs) */
  private sentRefs = new Set<string>()

  constructor(o: BlobSyncOptions) {
    this.o = { pieceSize: 2 << 20, verifyTtlMs: 60_000, now: Date.now, ...o }
  }

  status(): BlobStatus { return { ...this.st } }
  private set(p: Partial<BlobStatus>) { this.st = { ...this.st, ...p }; this.o.onChange?.() }

  // ---- the outbox gate ----------------------------------------------------------------------------------------------------------
  async ready(rows: OutboxRow[]): Promise<OutboxRow[]> {
    const heldDocs = new Set<string>()
    const out: OutboxRow[] = []
    for (const r of rows) {
      const hs = r.blobs ?? []
      if (!hs.length && !heldDocs.size) { out.push(r); continue }
      const doc = parseEnvelope(r.env).doc
      if (heldDocs.has(doc)) continue
      let ok = true
      for (const h of hs) if (!(await this.isReady(h))) { ok = false; break }
      if (!ok) { heldDocs.add(doc); continue }
      for (const h of hs) this.sentRefs.add(h)
      out.push(r)
    }
    return out
  }

  /** A name in an op is released when: this device holds no file of that name (not an attachment here, or from another workspace: nothing
   *  to upload); or the file can never be uploaded (the page must not stay stuck for ever: it shows "missing" elsewhere); or the server
   *  HAS it, which is ASKED, not assumed from the local row: the device may have downloaded it long ago, or uploaded it and then slept
   *  for weeks while the server collected it. A file the server lacks is uploaded again from the local bytes and the op waits. */
  private async isReady(hash: string): Promise<boolean> {
    const m = await this.o.blobs.meta(hash)
    if (!m || m.failed) return true
    if (!m.remote) return false
    const at = this.verified.get(hash)
    if (at !== undefined && this.o.now() - at < this.o.verifyTtlMs) return true
    const h = await this.o.net.head(this.o.ws, hash) // a network error propagates: the push retries later
    if (h.stored) { this.verified.set(hash, this.o.now()); return true }
    await this.o.blobs.setRemote(hash, false) // collected on the server: upload it again, the op waits
    this.refresh()
    return false
  }

  // ---- upload -------------------------------------------------------------------------------------------------------------------
  /** Starts (or joins) the upload of every pending file. Resolves when it has finished or stopped on an error. */
  uploadPending(): Promise<void> {
    return (this.uploadRun ??= this.runUploads().finally(() => { this.uploadRun = null; this.set({ uploading: false }) }))
  }

  private async refresh() { this.st = { ...this.st, pending: (await this.o.blobs.pending()).length }; this.o.onChange?.() }

  private async runUploads(): Promise<void> {
    for (;;) {
      const list = await this.o.blobs.pending()
      this.set({ pending: list.length })
      const next = list[0]
      if (!next) { this.set({ error: this.st.error === 'quota' ? '' : this.st.error }); return }
      this.set({ uploading: true, sent: 0, total: next.size })
      try {
        await this.uploadOne(next)
        this.set({ error: '' })
        this.o.onUploaded?.()
      } catch (e) {
        if (!(e instanceof NetError)) throw e
        if (e.code === 'quota_exceeded') { this.set({ error: 'quota' }); return }
        if (e.code === 'blob_too_large' || e.code === 'hash_mismatch' || e.code === 'size_mismatch') { await this.o.blobs.setFailed(next.hash, e.code); this.set({ error: e.code }); continue }
        this.set({ error: e.status === 0 ? 'offline' : e.code })
        return // network trouble or an auth problem: the next sync round tries again
      }
    }
  }

  private async uploadOne(m: BlobMeta): Promise<void> {
    const data = await this.o.blobs.get(m.hash)
    if (!data) { await this.o.blobs.setFailed(m.hash, 'local_bytes_missing'); return }
    const h = await this.o.net.head(this.o.ws, m.hash)
    if (h.stored) { await this.o.blobs.setRemote(m.hash, true); return }
    let offset = Math.min(h.received, data.size)
    let skews = 0
    for (;;) {
      const end = Math.min(offset + this.o.pieceSize, data.size)
      try {
        const r = await this.o.net.put(this.o.ws, m.hash, data.slice(offset, end), offset, data.size)
        offset = r.received
        this.set({ sent: offset })
        if (r.complete) break
      } catch (e) {
        // the server holds fewer bytes than we thought (a restart, a lost answer): continue from what it says it has
        if (e instanceof NetError && e.code === 'out_of_order' && skews++ < 5) { offset = Number(e.details.received ?? 0); continue }
        throw e
      }
    }
    await this.o.blobs.setRemote(m.hash, true)
  }

  // ---- download -----------------------------------------------------------------------------------------------------------------
  /** The bytes of an attachment: from this device, else from the server (ranges of 4 MB, verified against the name before they are
   *  kept). undefined = not available now (the server does not have it yet, or we are offline): ask again later. */
  fetch(hash: string, mime = ''): Promise<Blob | undefined> {
    const running = this.downloads.get(hash)
    if (running) return running
    const p = this.download(hash, mime).finally(() => this.downloads.delete(hash))
    this.downloads.set(hash, p)
    return p
  }

  private async download(hash: string, mime: string): Promise<Blob | undefined> {
    const have = await this.o.blobs.get(hash)
    if (have) return have
    const CHUNK = 4 << 20
    const parts: Blob[] = []
    let got = 0
    let total = Infinity
    try {
      while (got < total) {
        const r = await this.o.net.get(this.o.ws, hash, got, got + CHUNK - 1)
        total = r.total
        parts.push(r.data)
        got += r.data.size
        if (r.data.size === 0) break
      }
    } catch (e) {
      if (e instanceof NetError && (e.code === 'no_such_blob' || e.status === 0 || e.retryable)) return undefined
      throw e
    }
    const whole = new Blob(parts, { type: mime })
    if (whole.size !== total || (await sha256Hex(whole)) !== hash) return undefined // never keep bytes that do not match their name
    await this.o.blobs.putRemote(hash, whole, mime)
    return whole
  }

  // ---- references (for the server's garbage collection) -------------------------------------------------------------------------
  /** Tells the server what the workspace refers to. Always sends the hashes of ops sent since the last time (a list that can only keep
   *  blobs). Once a day, when everything pulled has been applied, also sends the COMPLETE list (read from every page, record and event,
   *  trashed ones included), which is what lets the server start the 30 days for blobs nobody refers to. Never throws on a network
   *  error: the next round repeats it. */
  async reportRefs(store: Store, o: { force?: boolean } = {}): Promise<void> {
    const partial = [...this.sentRefs]
    try {
      if (partial.length) { await this.o.net.reportRefs(this.o.ws, 0, partial); for (const h of partial) this.sentRefs.delete(h) }
      const last = Number((await store.run(tx => tx.getMeta('blobRefsAt'))) ?? 0)
      if (!o.force && this.o.now() - last < DAY) return
      const full = await collectReferences(store)
      if (!full) return // pulled but not yet applied ops are not in the local documents: a list made now could condemn a blob they refer to
      const r = await this.o.net.reportRefs(this.o.ws, full.cursor, [...full.refs])
      if (r.applied) await store.run(tx => tx.setMeta('blobRefsAt', String(this.o.now())))
    } catch (e) {
      if (!(e instanceof NetError)) throw e
    }
  }
}

/** Every attachment name this workspace's local state holds, and the cursor it is complete up to; null when the state is not complete
 *  (ops are waiting in the inbox, or the cursor moved while reading). */
export async function collectReferences(store: Store): Promise<{ cursor: number; refs: Set<string> } | null> {
  const state = () => store.run(async tx => ({ cursor: Number((await tx.getMeta('cursor')) ?? 0), inbox: (await tx.listInbox(0, 1)).length }))
  const before = await state()
  if (before.inbox) return null
  const refs = new Set<string>()
  const enc = new TextEncoder()
  const docs = await store.run(tx => tx.docs())
  for (let i = 0; i < docs.length; i += 50) {
    await store.run(async tx => {
      for (const d of docs.slice(i, i + 50)) {
        const s = await tx.getDocState(d)
        if (s?.state) hexNamesIn(s.state, refs)
        for (const u of await tx.listDocUpdates(d)) hexNamesIn(u.upd, refs)
      }
    })
  }
  await store.run(async tx => {
    for (const f of await tx.allFields()) hexNamesIn(enc.encode(f.val), refs)
    for (const e of await tx.allEvents()) hexNamesIn(enc.encode(e.body), refs)
  })
  const after = await state()
  return after.cursor === before.cursor && !after.inbox ? { cursor: after.cursor, refs } : null
}
