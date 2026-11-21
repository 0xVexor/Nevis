// Captures two REALISTIC sv1 golden fixtures through the real app stack (editor + DocHandle + store), before SV is raised:
// what a person's M5 page really looks like in storage: many merged updates, deletions, real UUIDv7 block ids, undo history,
// and the compacted `doc_state` + tail. Run ONCE (files are never overwritten):
//   (server on 8787 and vite on 5174 running)   npx tsx apps/web/scripts/capture-sv1-realistic.mts
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import * as Y from 'yjs'
import { SV } from '@nevis/protocol'
import { project } from '@nevis/schema'

if (SV !== 1) throw new Error(`these fixtures are for sv1 and must be captured BEFORE the bump (SV is ${SV})`)
const out = join(import.meta.dirname, '../../../packages/schema/fixtures/sv1')
const BASE = process.env.BASE ?? 'http://localhost:5174'
const user = `cap${Date.now().toString(36)}`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await (await browser.newContext()).newPage()
await page.addInitScript('window.__name = f => f') // tsx/esbuild wraps functions with __name; the page has no such helper
await page.goto(BASE)
await page.getByRole('button', { name: 'حساب ندارم' }).click()
await page.locator('input[name=username]').fill(user)
await page.locator('input[name=password]').fill('correct horse battery')
await page.getByTestId('auth-submit').click()
await page.getByTestId('recovery').waitFor()
await page.getByTestId('ws-new').click()
await page.getByTestId('new-page').click()
await page.locator('.ProseMirror').click()
const raw = await page.evaluate(async () => {
  const w = window as unknown as { __ws: any; __editor: any }
  const ed = w.__editor, ws = w.__ws
  const words = ['سلام', 'دنیا', 'نوشتن', 'کتاب', 'می‌خواهم', '۱۲۳', 'hello', 'world', 'Nevis', 'گربه']
  const id = (document.querySelector('[data-testid=page-row]') as HTMLElement).dataset.id!
  for (let i = 0; i < 320; i++) {
    ed.commands.insertContent(words[i % words.length] + ' ')
    const k = i % 23
    if (k === 5) ed.commands.splitBlock()
    if (k === 9) ed.chain().toggleBold().run()
    if (k === 12) ed.chain().toggleBulletList().run()
    if (k === 15) { const { from } = ed.state.selection; if (from > 6) ed.commands.deleteRange({ from: from - 5, to: from - 1 }) }
    if (k === 18) ed.commands.undo()
    if (k === 20) ed.commands.redo()
    if (k === 22) ed.chain().toggleHeading({ level: 2 }).run()
    await ws.flushAll() // one stored update per step, like a person typing with pauses
  }
  const store = ws.rt.store
  const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
  const r = await store.run(async (tx: any) => ({ state: await tx.getDocState(id), tail: await tx.listDocUpdates(id) }))
  return { id, state: r.state?.state ? b64(r.state.state) : null, tail: r.tail.map((t: any) => b64(t.upd)) as string[] }
})
await browser.close()

const updates = [...(raw.state ? [raw.state] : []), ...raw.tail]
const doc = new Y.Doc()
for (const u of updates) Y.applyUpdate(doc, new Uint8Array(Buffer.from(u, 'base64')))
const proj = project(doc)
const text = JSON.stringify(proj)
if (!/[؀-ۿ]/.test(text) || !text.includes('bulletList') || !text.includes('heading')) throw new Error('the captured page lacks the expected content')
const ids = [...text.matchAll(/"blockId":"([^"]*)"/g)].map(m => m[1]!)
if (!ids.some(i => /^[0-9a-f-]{36}$/.test(i))) throw new Error('no real block ids in the captured page')
console.log(`captured: ${raw.state ? 'compacted state + ' : ''}${raw.tail.length} tail updates, ${updates.length} in all, ${ids.length} blocks with ids`)

const hash = (us: string[]) => createHash('sha256').update(Buffer.concat(us.map(u => Buffer.from(u, 'base64')))).digest('hex')
const write = (name: string, rec: object) => { const f = join(out, `${name}.json`); if (existsSync(f)) { console.log('skip (exists)', name); return } writeFileSync(f, JSON.stringify(rec, null, 1) + '\n', { flag: 'wx' }); console.log('captured', name) }
write('real-m5-store', { name: 'real-m5-store', sv: SV, updates, sha256: hash(updates), projection: proj, note: 'doc_state (if compacted) then the doc_update tail, applied in order: how the app stores a page' })
const merged = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
write('real-m5-merged', { name: 'real-m5-merged', sv: SV, updates: [merged], sha256: hash([merged]), projection: proj, note: 'the same page as one encodeStateAsUpdate (what a fresh device receives)' })
