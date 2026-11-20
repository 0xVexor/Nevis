// `Nevis --typing`: the kill test (ROADMAP M6). The page types into the real editor (DocHandle on SQLite) one character every
// 50 ms and tells the parent through stdout after each one (`KEY <n>`); the parent sends SIGKILL at a random moment. A second run
// with NEVIS_VERIFY=1 reads the document back and prints `FOUND <n>`: the characters that survived.
import { Client, DocHandle } from '@nevis/core'
import { createEditor } from '@nevis/editor'
import { appInfo, invoke, isDesktop, openDesktopStore } from './desktop'

const WS = 'killtest'
const DOC = '00000000-0000-7000-8000-00000000d0c1'

async function main() {
  if (!isDesktop) throw new Error('not running inside the desktop app')
  const verify = (await appInfo()).verify
  const store = openDesktopStore(WS)
  const client = new Client({ store, ws: WS, device: '00000000-0000-7000-8000-0000000000d1', sv: 1 })
  const h = await DocHandle.open({ client, doc: DOC })
  const host = document.createElement('div'); document.body.append(host)
  const ed = createEditor(h.ydoc, host)
  if (verify) {
    const found = ed.getText().replace(/\s/g, '').length
    await invoke('app_exit', { code: 0, report: `FOUND ${found}` })
    return
  }
  ed.commands.focus()
  for (let i = 1; ; i++) {
    ed.commands.insertContent('ک')
    await invoke('app_log', { line: `KEY ${i}` })
    await new Promise(r => setTimeout(r, 50))
  }
}
main().catch(async e => { await invoke('app_exit', { code: 2, report: `typing crashed: ${String((e as Error)?.stack ?? e)}` }) })
