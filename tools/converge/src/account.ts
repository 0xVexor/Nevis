// A real account on the server for the harness (M4): sign up (solving the proof of work) or sign in, as a device, and get a token.
import { createHash } from 'node:crypto'

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Nevis-Proto': '1' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any }
}

function solve(challenge: string, bits: number): number {
  for (let counter = 0; ; counter++) {
    const d = createHash('sha256').update(`${challenge}:${counter}`).digest()
    let zeros = 0
    for (const b of d) { if (b === 0) { zeros += 8; continue } zeros += Math.clz32(b) - 24; break }
    if (zeros >= bits) return counter
  }
}

export async function deviceToken(base: string, username: string, password: string, invite?: string): Promise<string> {
  const ch = await (await fetch(`${base}/v1/auth/challenge`)).json() as { challenge: string; bits: number }
  const up = await post(base, '/v1/auth/signup', { username, password, client: 'device', deviceName: 'harness', invite, challenge: ch.challenge, counter: ch.bits ? solve(ch.challenge, ch.bits) : 0 })
  if (up.status === 200) return up.json.token
  if (up.status !== 409) throw new Error(`signup failed: ${up.status} ${JSON.stringify(up.json)}`)
  const inn = await post(base, '/v1/auth/signin', { username, password, client: 'device', deviceName: 'harness' })
  if (inn.status !== 200) throw new Error(`signin failed: ${inn.status} ${JSON.stringify(inn.json)}`)
  return inn.json.token
}

export async function createWorkspace(base: string, token: string, id: string, name = 'converge'): Promise<void> {
  const r = await fetch(`${base}/v1/ws`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Nevis-Proto': '1' }, body: JSON.stringify({ id, name }) })
  if (r.status !== 201) throw new Error(`create workspace failed: ${r.status} ${await r.text()}`)
}
