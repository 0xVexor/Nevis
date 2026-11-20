// Browser side of M4 sign-in: a cookie session (the server sets an HttpOnly cookie; scripts never see the token).
export interface Me { account: { id: string; username: string }; usedBytes: number; quotaBytes: number }
export interface WorkspaceInfo { id: string; name: string; role: string; head: number }
export class AuthError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, { method, headers: { 'Nevis-Proto': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new AuthError(res.status, j?.error?.code ?? `http_${res.status}`, j?.error?.message ?? `HTTP ${res.status}`)
  return j
}

/** Proof of work for sign-up: find a counter so SHA-256(`challenge:counter`) has `bits` leading zero bits. */
async function solve(challenge: string, bits: number): Promise<number> {
  const enc = new TextEncoder()
  for (let c = 0; ; c++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${c}`)))
    let zeros = 0
    for (const b of d) { if (b === 0) { zeros += 8; continue } zeros += Math.clz32(b) - 24; break }
    if (zeros >= bits) return c
  }
}

export const me = (): Promise<Me | null> => call('GET', '/v1/me').catch(e => { if (e instanceof AuthError && e.status === 401) return null; throw e })
export const signIn = (username: string, password: string, deviceName: string) => call('POST', '/v1/auth/signin', { username, password, client: 'web', deviceName })
export const signOut = () => call('POST', '/v1/auth/signout')
export const workspaces = async (): Promise<WorkspaceInfo[]> => (await call('GET', '/v1/ws')).workspaces
export const createWorkspace = (id: string, name: string) => call('POST', '/v1/ws', { id, name })
export async function signUp(username: string, password: string, deviceName: string, invite: string): Promise<{ recoveryKey?: string }> {
  const ch = await call('GET', '/v1/auth/challenge')
  const counter = ch.bits ? await solve(ch.challenge, ch.bits) : 0
  return call('POST', '/v1/auth/signup', { username, password, client: 'web', deviceName, invite: invite || undefined, challenge: ch.challenge, counter })
}
export const deviceLabel = (): string => (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Firefox/.test(navigator.userAgent) ? 'Firefox' : /Chrome/.test(navigator.userAgent) ? 'Chrome' : 'Safari')
