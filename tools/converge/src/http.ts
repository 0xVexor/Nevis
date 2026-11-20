// The Net port over HTTP, against the real Go server.
import { NetError, type Net, type PullResult, type PushResult } from '@nevis/core'

export function httpNet(base: string, token: string): Net {
  const call = async (method: string, path: string, body?: string) => {
    let res: Response
    try {
      res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Nevis-Proto': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body })
    } catch {
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
    async pull(ws, after, limit): Promise<PullResult> {
      const j = await call('GET', `/v1/ws/${ws}/ops?after=${after}&limit=${limit}`)
      return { head: j.head, more: j.more, ops: j.ops.map((o: any) => ({ seq: o.seq, by: o.by, rt: o.rt, env: JSON.stringify(o.env) })) }
    },
  }
}
