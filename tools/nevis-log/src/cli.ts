// pnpm nevis-log --server http://localhost:8787 --user NAME [--password PW] [--ws ID] [--after N] [--json]
// Pulls a workspace's log and prints it readably. The SERVER cannot do this (it never decodes a payload); this decodes on the client.
import { httpNet } from '@nevis/core'
import { b64urlDecode, decodeEvt, decodeFrame, decodeRec, FRAME, parseEnvelope, parseHlc } from '@nevis/protocol'
import * as Y from 'yjs'
import { parseArgs } from 'node:util'

const { values: v } = parseArgs({ options: { server: { type: 'string', default: 'http://localhost:8787' }, user: { type: 'string' }, password: { type: 'string', default: 'correct horse battery' }, ws: { type: 'string' }, after: { type: 'string', default: '0' }, json: { type: 'boolean', default: false }, token: { type: 'string' } } })
const server = v.server!

async function token(): Promise<string> {
  if (v.token) return v.token
  if (!v.user) { console.error('give --user NAME (and --password), or --token'); process.exit(2) }
  const r = await fetch(`${server}/v1/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Nevis-Proto': '1' }, body: JSON.stringify({ username: v.user, password: v.password, client: 'device', deviceName: 'nevis-log' }) })
  const j = (await r.json()) as any
  if (!r.ok) { console.error(`sign-in failed: ${j?.error?.code ?? r.status}`); process.exit(1) }
  return j.token
}

const tok = await token()
const auth = { headers: { Authorization: `Bearer ${tok}`, 'Nevis-Proto': '1' } }
if (!v.ws) {
  const j = (await (await fetch(`${server}/v1/ws`, auth)).json()) as any
  console.log('workspaces (pick one with --ws):')
  for (const w of j.workspaces ?? []) console.log(`  ${w.id}  ${w.name}  role=${w.role}  head=${w.head}`)
  process.exit(0)
}

const net = httpNet({ base: server, token: tok })
const short = (s: string) => s.slice(0, 8)
const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
let after = Number(v.after)
let total = 0
for (;;) {
  const page = await net.pull(v.ws, after, 1000)
  for (const op of page.ops) {
    after = op.seq
    total++
    let line: string
    try {
      const e = parseEnvelope(op.env)
      const hlc = parseHlc(e.t)
      const f = decodeFrame(b64urlDecode(e.p))
      let what = ''
      if (f.kind === FRAME.rec) { const r = decodeRec(f.data); what = `rec ${r.kind ? `[new ${r.kind}] ` : ''}${clip(JSON.stringify(r.set))}` }
      else if (f.kind === FRAME.evt) { const x = decodeEvt(f.data); what = `evt ${x.kind} ${clip(JSON.stringify(x.body))}` }
      else if (f.kind === FRAME.yupd) { const d = new Y.Doc(); Y.applyUpdate(d, f.data); what = `yupd ${f.data.length} B → this update alone → ${clip(d.getXmlFragment('body').toString() || '(empty)')}` }
      else what = `frame ${f.kind}`
      line = v.json ? JSON.stringify({ seq: op.seq, by: op.by, rt: op.rt, doc: e.doc, dev: e.dev, t: e.t, sv: e.sv, what }) : `${String(op.seq).padStart(6)}  ${new Date(hlc!.ms).toISOString().slice(11, 23)}  dev ${short(e.dev)}  doc ${short(e.doc)}  sv${e.sv}  ${what}`
    } catch (err) { line = `${String(op.seq).padStart(6)}  (cannot decode: ${(err as Error).message})` }
    console.log(line)
  }
  if (!page.more) break
}
console.error(`${total} op(s)`)
