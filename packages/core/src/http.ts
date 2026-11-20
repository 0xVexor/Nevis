// The Net port over HTTP (fetch). Same-origin in the browser; a base URL elsewhere. Network trouble is a retryable NetError.
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
    async pull(ws, after, limit, opts): Promise<PullResult> {
      const j = await call('GET', `/v1/ws/${ws}/ops?after=${after}&limit=${limit}${opts?.wait ? `&wait=${opts.wait}` : ''}`, undefined, opts?.signal)
      return { head: j.head, more: j.more, ops: j.ops.map((o: any) => ({ seq: o.seq, by: o.by, rt: o.rt, env: JSON.stringify(o.env) })) }
    },
  }
}
