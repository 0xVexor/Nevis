// Attachments in the core (ADR-0001 §3, ADR-0005 "outbox gate", ROADMAP M9). Bytes NEVER travel inside an op or a store transaction:
// they have their own port, `BlobStore`, whose writes are ordered by the caller: bytes durable first, then the row that names them,
// then (much later, in another transaction) the op that points at them. A crash can leave bytes nobody refers to (harmless, the
// server collects them after 30 days); it can never leave a reference to bytes that were never stored.

export interface BlobMeta {
  /** SHA-256 of the bytes, 64 lowercase hex digits: the name of the attachment everywhere */
  hash: string
  size: number
  /** what the person's device said it was (shown, never trusted: the server ignores it and an image is sniffed again before drawing) */
  mime: string
  /** the server has the complete file */
  remote: boolean
  /** '' or why the upload can never succeed (too large for the server, hash refused): the op that refers to it is no longer held back */
  failed: string
}

export interface BlobStore {
  /** Stores the bytes, then the row (remote = false), unless the hash is already stored (then the existing row is returned). */
  put(hash: string, data: Blob, mime: string): Promise<BlobMeta>
  /** A blob whose bytes came from the server: stored with remote = true. */
  putRemote(hash: string, data: Blob, mime: string): Promise<BlobMeta>
  meta(hash: string): Promise<BlobMeta | undefined>
  get(hash: string): Promise<Blob | undefined>
  /** Rows with remote = false and no `failed`, oldest first. */
  pending(): Promise<BlobMeta[]>
  all(): Promise<BlobMeta[]>
  setRemote(hash: string, remote: boolean): Promise<void>
  setFailed(hash: string, reason: string): Promise<void>
  delete(hash: string): Promise<void>
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(data: Blob | Uint8Array): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  return hex(await crypto.subtle.digest('SHA-256', buf))
}

/** Which of `hashes` appear in `payload` (the bytes of an op): a hash is 64 ASCII characters, which Yjs and JSON both keep contiguous. The
 *  content is what is read, never any bookkeeping of the editor, so a paste, a move between pages and an undo that brings a block back
 *  are all found. */
export function hashesIn(payload: Uint8Array, hashes: string[]): string[] {
  if (!hashes.length) return []
  let s = ''
  for (let i = 0; i < payload.length; i += 0x8000) s += String.fromCharCode(...payload.subarray(i, i + 0x8000))
  return hashes.filter(h => s.includes(h))
}

/** Every attachment-looking name (64 hex characters) in `text`: for the reference report, which reads whole documents. */
export function hexNamesIn(payload: Uint8Array, into: Set<string>): void {
  let run = 0
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i]!
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102)) {
      run++
      if (run >= 64) { let s = ''; for (let j = i - 63; j <= i; j++) s += String.fromCharCode(payload[j]!); into.add(s) }
    } else run = 0
  }
}

/** A BlobStore in memory: for tests and for the harness. */
export class MemoryBlobStore implements BlobStore {
  private rows = new Map<string, { meta: BlobMeta; data: Blob; n: number }>()
  private n = 0
  async put(hash: string, data: Blob, mime: string): Promise<BlobMeta> {
    const have = this.rows.get(hash)
    if (have) return { ...have.meta }
    const meta: BlobMeta = { hash, size: data.size, mime, remote: false, failed: '' }
    this.rows.set(hash, { meta, data, n: this.n++ })
    return { ...meta }
  }
  async putRemote(hash: string, data: Blob, mime: string): Promise<BlobMeta> {
    const have = this.rows.get(hash)
    if (have) { have.meta.remote = true; return { ...have.meta } }
    const meta: BlobMeta = { hash, size: data.size, mime, remote: true, failed: '' }
    this.rows.set(hash, { meta, data, n: this.n++ })
    return { ...meta }
  }
  async meta(hash: string) { const r = this.rows.get(hash); return r && { ...r.meta } }
  async get(hash: string) { return this.rows.get(hash)?.data }
  async pending() { return [...this.rows.values()].filter(r => !r.meta.remote && !r.meta.failed).sort((a, b) => a.n - b.n).map(r => ({ ...r.meta })) }
  async all() { return [...this.rows.values()].map(r => ({ ...r.meta })) }
  async setRemote(hash: string, remote: boolean) { const r = this.rows.get(hash); if (r) r.meta.remote = remote }
  async setFailed(hash: string, reason: string) { const r = this.rows.get(hash); if (r) r.meta.failed = reason }
  async delete(hash: string) { this.rows.delete(hash) }
}
