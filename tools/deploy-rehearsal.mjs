// A rehearsal of the server deployment on this machine, as an owner would do it: the release layout, an invite-only server, a real browser that
// signs up with the invite code and writes a page, a backup taken with deploy/backup.sh while the server runs, a NEW server started from
// that backup alone, and the same account signing in there and finding its page.   node tools/deploy-rehearsal.mjs <release-web-dir>
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const web = process.argv[2]
if (!web) throw new Error('usage: node tools/deploy-rehearsal.mjs <web dir of the release>')
const root = mkdtempSync(join(tmpdir(), 'nevis-rehearsal-'))
const bin = join(root, 'nevis-server')
execFileSync('go', ['build', '-o', bin, './cmd/nevis-server'], { cwd: 'server', stdio: 'inherit' })
const env = (data, port) => ({ ...process.env, SESSION_SECRET: 'a'.repeat(64), REGISTRATION: 'invite', INVITE_CODES: 'rehearsal-code', DATA_DIR: data, WEB_DIR: web, LISTEN_HOST: '127.0.0.1', PORT: String(port), INSECURE_COOKIES: '1' })
const start = async (data, port) => {
  const p = spawn(bin, [], { env: env(data, port), stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return p } catch { /* not yet */ } await new Promise(r => setTimeout(r, 100)) }
  throw new Error('the server did not start')
}
const user = 'rehearsal' + Date.now().toString(36), pass = 'correct horse battery', title = 'برگهٔ تمرین بازگردانی', text = 'متنی که باید بعد از بازگردانی هم باشد'
const browser = await chromium.launch({ channel: 'chrome' })
let a, b
try {
  // 1. the first server and a person using it
  const data1 = join(root, 'data1'); a = await start(data1, 8790)
  const ctx = await browser.newContext(); const page = await ctx.newPage(); page.setDefaultTimeout(120_000)
  await page.goto('http://127.0.0.1:8790/')
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill(user); await page.locator('input[name=password]').fill(pass); await page.locator('input[name=invite]').fill('rehearsal-code')
  await page.getByTestId('auth-submit').click(); await page.getByTestId('recovery').waitFor()
  await page.getByTestId('ws-new').click(); await page.waitForFunction(() => !!window.__ws?.rt?.client)
  await page.evaluate(async ([t, x]) => { const ws = window.__ws; const id = await ws.newPage('', t); await ws.writeBody(id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: x }] }] }) }, [title, text])
  await page.waitForFunction(async () => { const s = await window.__ws.status(); return s.outbox === 0 && s.unsaved === 0 }, null, { timeout: 60_000 })
  console.log('1. signed up with the invite code, wrote a page, everything reached the server')
  // 2. a backup while the server runs
  const dest = join(root, 'backups')
  execFileSync('bash', ['deploy/backup.sh', data1, dest], { env: { ...process.env, NEVIS_BIN: bin }, stdio: 'inherit' })
  console.log('2. backup taken with deploy/backup.sh:', readdirSync(dest).join(', '))
  a.kill(); await ctx.close()
  // 3. a new server that has nothing but the backup
  const data2 = join(root, 'data2'); mkdirSync(data2, { recursive: true })
  const stamp = readdirSync(dest).filter(n => /^\d{8}-\d{6}$/.test(n)).sort().pop()
  cpSync(join(dest, stamp, 'nevis.db'), join(data2, 'nevis.db'))
  if (readdirSync(dest).includes('blobs')) cpSync(join(dest, 'blobs'), join(data2, 'blobs'), { recursive: true })
  b = await start(data2, 8791)
  const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage(); p2.setDefaultTimeout(120_000)
  await p2.goto('http://127.0.0.1:8791/')
  await p2.locator('input[name=username]').fill(user); await p2.locator('input[name=password]').fill(pass); await p2.getByTestId('auth-submit').click()
  await p2.getByTestId('ws-list').getByRole('button').first().click()
  await p2.getByTestId('page-row').first().dblclick()
  await p2.getByTestId('title').waitFor()
  const got = [await p2.getByTestId('title').inputValue(), await p2.getByTestId('editor').innerText()]
  if (got[0] !== title || !got[1].includes(text)) throw new Error('the restored server does not have the page: ' + JSON.stringify(got))
  console.log('3. the restored server signed the same account in and shows the page and its text')
  console.log('REHEARSAL OK')
} finally { a?.kill(); b?.kill(); await browser.close() }
