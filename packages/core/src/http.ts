// The Net port over HTTP (fetch). Same-origin in the browser; a base URL elsewhere. Network trouble is a retryable NetError.
import type { BlobNet } from './blobSync'
import { NetError, type Net, type PullResult, type PushResult } from './engine'

export interface HttpNetOptions {
  /** '' = same origin */
  base?: string
  /** development bearer token (M2-M3); real sessions come in M4 */
  token?: string
  fetch?: typeof fetch
  /** lets a test or a "network off" switch refuse requests */
  offline?: () => boolean
}

export function httpNet(o: HttpNetOptions = {}): Net {
  const base = (o.base ?? '').replace(/\/+$/, '')
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const call = async (method: string, path: string, body?: string, signal?: AbortSignal) => {
    if (o.offline?.()) throw new NetError(0, 'offline', true)
    let res: Response
    try {
      res = await f(base + path, { method, headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), 'Nevis-Proto': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body, signal })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new NetError(0, 'unreachable', true)
    }
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok) {
      const e = json?.error
      throw new NetError(res.status, e?.code ?? `http_${res.status}`, e?.retryable ?? res.status >= 500, e?.message ?? text.slice(0, 200))
    }
    return json
  }
  return {
    async push(ws, envs): Promise<PushResult> {
      return call('POST', `/v1/ws/${ws}/ops`, `{"ops":[${envs.join(',')}]}`)
    },
    async candidates(ws, min) {
      return (await call('GET', `/v1/ws/${ws}/snapshots/candidates?min=${min}`)).docs.map((d: { doc: string }) => d.doc)
    },
    async pull(ws, after, limit, opts): Promise<PullResult> {
      const j = await call('GET', `/v1/ws/${ws}/ops?after=${after}&limit=${limit}${opts?.wait ? `&wait=${opts.wait}` : ''}${opts?.compact ? '&compact=1' : ''}`, undefined, opts?.signal)
      return { head: j.head, more: j.more, ops: j.ops.map((o: any) => ({ seq: o.seq, by: o.by, rt: o.rt, env: JSON.stringify(o.env) })) }
    },
  }
}

/** The Net of attachments over HTTP (same options as `httpNet`). Pieces go as raw bytes; nothing here is JSON except the answers. */
export function httpBlobNet(o: HttpNetOptions = {}): BlobNet {
  const base = (o.base ?? '').replace(/\/+$/, '')
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const send = async (method: string, path: string, init: { body?: Blob; headers?: Record<string, string> } = {}): Promise<Response> => {
    if (o.offline?.()) throw new NetError(0, 'offline', true)
    try {
      return await f(base + path, { method, body: init.body, headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), 'Nevis-Proto': '1', ...init.headers } })
    } catch {
      throw new NetError(0, 'unreachable', true)
    }
  }
  const failure = async (res: Response): Promise<NetError> => {
    let e: any = null
    try { e = ((await res.json()) as any)?.error } catch { /* not JSON */ }
    const { code, message, retryable, ...details } = e ?? {}
    return new NetError(res.status, code ?? `http_${res.status}`, retryable ?? res.status >= 500, message ?? `HTTP ${res.status}`, details)
  }
  return {
    async head(ws, hash) {
      const res = await send('HEAD', `/v1/ws/${ws}/blobs/${hash}`)
      if (res.status === 200) return { stored: true, size: Number(res.headers.get('Nevis-Size') ?? 0) }
      if (res.status === 404 && res.headers.has('Nevis-Received')) return { stored: false, received: Number(res.headers.get('Nevis-Received')) }
      throw await failure(res)
    },
    async put(ws, hash, piece, offset, total) {
      const res = await send('PUT', `/v1/ws/${ws}/blobs/${hash}?offset=${offset}&total=${total}`, { body: piece, headers: { 'Content-Type': 'application/octet-stream' } })
      if (!res.ok) throw await failure(res)
      const j = (await res.json()) as any
      return { complete: !!j.complete, received: Number(j.received) }
    },
    async get(ws, hash, start, end) {
      const res = await send('GET', `/v1/ws/${ws}/blobs/${hash}`, { headers: { Range: `bytes=${start}-${end}` } })
      if (res.status === 416) return { data: new Blob([]), total: start } // the file ended before `start`: nothing more
      if (!res.ok) throw await failure(res)
      const data = await res.blob()
      const range = res.headers.get('Content-Range') // "bytes 0-9/100"
      const total = range ? Number(range.split('/')[1]) : data.size
      return { data, total }
    },
    async reportRefs(ws, cursor, refs) {
      const res = await send('POST', `/v1/ws/${ws}/blobs/refs`, { body: new Blob([JSON.stringify({ cursor, refs })]), headers: { 'Content-Type': 'application/json' } })
      if (!res.ok) throw await failure(res)
      return { applied: !!((await res.json()) as any).applied }
    },
  }
}
