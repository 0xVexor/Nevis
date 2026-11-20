// `Nevis --sync`: one side of the desktop <-> web convergence test (scripts/converge.mjs drives the other side with a browser).
//  phase a: sign up as a device, make a workspace, write a page (title + body) and push it; prints `WS <id>`.
//  phase b: NO sign-in (the token must come from the keychain/file after a restart): pull, print the pages and the body text.
import { addOption, addProperty } from '@nevis/core'
import { createEditor } from '@nevis/editor'
import { uuidv7 } from '@nevis/protocol'
import { createWorkspace, me, signUp } from './auth'
import { appInfo, invoke, isDesktop } from './desktop'
import { Workspace } from './workspace'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function settle(ws: Workspace) {
  for (let i = 0; i < 100; i++) {
    await ws.rt.engine.cycle()
    await ws.reload()
    if ((await ws.status()).outbox === 0) return
    await sleep(100)
  }
  throw new Error('the outbox did not empty')
}

async function main() {
  if (!isDesktop) throw new Error('not running inside the desktop app')
  const info = await appInfo()
  const { user, ws: wsId, phase } = info.env
  if (phase === 'a') {
    await signUp(user!, 'correct horse battery', 'Nevis Desktop', '')
    const id = uuidv7()
    await createWorkspace(id, 'desktop-web')
    const ws = new Workspace(id, null)
    await ws.start()
    const page = await ws.newPage('', 'از دسکتاپ')
    const h = await ws.openDoc(page)
    const host = document.createElement('div'); document.body.append(host)
    const ed = createEditor(h.ydoc, host)
    ed.commands.insertContent('متن دسکتاپ')
    await ws.flushAll()
    // a database with a select column and one option (the web adds another while the desktop is closed)
    const dbId = await ws.newDatabase('')
    const prop = await ws.mutate([], c => addProperty(c, dbId, { name: 'ژانر', type: 'select' }))
    await ws.mutate([prop], c => addOption(c, prop, { name: 'گزینهٔ دسکتاپ' }))
    await settle(ws)
    await ws.stop()
    await invoke('app_exit', { code: 0, report: `WS ${id}` })
  } else {
    if (!info.hasToken || !(await me())) throw new Error('not signed in after the restart: the token was not kept')
    const ws = new Workspace(wsId!, null)
    await ws.start()
    await settle(ws)
    const titles = ws.tree.roots.map(n => n.page.title)
    const options = [...ws.data.databases.values()].flatMap(d => d.properties.flatMap(p => p.options.map(o => o.name))).sort()
    const text: string[] = []
    for (const n of ws.tree.roots) {
      if (n.page.type === 'database') continue
      const h = await ws.openDoc(n.page.id)
      const host = document.createElement('div'); document.body.append(host)
      text.push(createEditor(h.ydoc, host).getText())
    }
    await ws.stop()
    await invoke('app_exit', { code: 0, report: `RESULT ${JSON.stringify({ titles, text, options })}` })
  }
}
main().catch(async e => { await invoke('app_exit', { code: 2, report: `sync crashed: ${String((e as Error)?.stack ?? e)}` }) })
