// The desktop adapters of attachments (ROADMAP M9): the core's `BlobStore` over Rust (files in the app data folder, rows in the
// workspace's SQLite) and the core's `BlobNet` over Rust's HTTP client (which adds the device token; JavaScript never sees it).
// Bytes cross the IPC as RAW bodies and responses: no base64 and no JSON, so a 50 MB file is not inflated by a third.
import { NetError } from '@nevis/core'
import type { BlobMeta, BlobNet, BlobStore } from '@nevis/core'

export type RawInvoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer())
const notFound = (e: unknown) => String(e) === 'not_found'

export class TauriBlobStore implements BlobStore {
  private readonly o: { ws: string; invoke: RawInvoke }
  constructor(o: { ws: string; invoke: RawInvoke }) { this.o = o }
  private write(hash: string, data: Blob, mime: string, remote: boolean) {
    return bytesOf(data).then(b => this.o.invoke('blob_put', b, { headers: { ws: this.o.ws, hash, mime, remote: remote ? '1' : '0' } })) as Promise<BlobMeta>
  }
  put(hash: string, data: Blob, mime: string) { return this.write(hash, data, mime, false) }
  putRemote(hash: string, data: Blob, mime: string) { return this.write(hash, data, mime, true) }
  async meta(hash: string) { return ((await this.o.invoke('blob_meta', { ws: this.o.ws, hash })) as BlobMeta | null) ?? undefined }
  async get(hash: string): Promise<Blob | undefined> {
    try { return new Blob([(await this.o.invoke('blob_get', { ws: this.o.ws, hash })) as ArrayBuffer]) } catch (e) { if (notFound(e)) return undefined; throw e }
  }
  async pending() { return (await this.o.invoke('blob_list', { ws: this.o.ws, pending: true })) as BlobMeta[] }
  async all() { return (await this.o.invoke('blob_list', { ws: this.o.ws, pending: false })) as BlobMeta[] }
  async setRemote(hash: string, remote: boolean) { await this.o.invoke('blob_set', { ws: this.o.ws, hash, remote, failed: null }) }
  async setFailed(hash: string, reason: string) { await this.o.invoke('blob_set', { ws: this.o.ws, hash, remote: null, failed: reason }) }
  async delete(hash: string) { await this.o.invoke('blob_delete', { ws: this.o.ws, hash }) }
}

export function tauriBlobNet(o: { invoke: RawInvoke; offline?: () => boolean }): BlobNet {
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    if (o.offline?.()) throw new NetError(0, 'offline', true)
    try { return await f() } catch (e) { throw e instanceof NetError ? e : new NetError(0, 'unreachable', true, String(e)) }
  }
  const parseError = (status: number, text: string) => {
    let e: any = null
    try { e = JSON.parse(text)?.error } catch { /* not JSON */ }
    const { code, message, retryable, ...details } = e ?? {}
    return new NetError(status, code ?? `http_${status}`, retryable ?? status >= 500, message ?? `HTTP ${status}`, details)
  }
  return {
    head: (ws, hash) => guard(async () => {
      const r = (await o.invoke('blob_head', { ws, hash })) as { status: number; size: number | null; received: number | null }
      if (r.status === 200) return { stored: true as const, size: r.size ?? 0 }
      if (r.status === 404) return { stored: false as const, received: r.received ?? 0 }
      throw parseError(r.status, '')
    }),
    put: (ws, hash, piece, offset, total) => guard(async () => {
      const r = (await o.invoke('blob_put_piece', await bytesOf(piece), { headers: { ws, hash, offset: String(offset), total: String(total) } })) as { status: number; text: string }
      if (r.status < 200 || r.status >= 300) throw parseError(r.status, r.text)
      const j = JSON.parse(r.text)
      return { complete: !!j.complete, received: Number(j.received) }
    }),
    get: (ws, hash, start, end) => guard(async () => {
      const buf = (await o.invoke('blob_get_range', { ws, hash, start, end })) as ArrayBuffer
      const head = new DataView(buf, 0, 10)
      const status = head.getUint16(0)
      const total = Number(head.getBigUint64(2))
      const body = buf.slice(10)
      if (status === 416) return { data: new Blob([]), total: start }
      if (status < 200 || status >= 300) throw parseError(status, new TextDecoder().decode(body))
      return { data: new Blob([body]), total }
    }),
    reportRefs: (ws, cursor, refs) => guard(async () => {
      const r = (await o.invoke('net_request', { method: 'POST', path: `/v1/ws/${ws}/blobs/refs`, body: JSON.stringify({ cursor, refs }), requestId: null })) as { status: number; text: string }
      if (r.status < 200 || r.status >= 300) throw parseError(r.status, r.text)
      return { applied: !!JSON.parse(r.text).applied }
    }),
  }
}
