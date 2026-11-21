// Injected ONLY in `--ui-test` mode (never in a normal run). Drives the real UI of the app from inside its WebView, because no
// outside tool drives a WKWebView. The phases run in separate launches on the same data folder (see scripts/ui.mjs).
(() => {
  const cfg = __CFG__
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {})
  const log = l => inv('app_log', { line: l })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const wait = async (fn, what, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(50) } }
  const tid = id => document.querySelector('[data-testid=' + id + ']')
  // React tracks controlled inputs through the native setter: a plain `.value =` would be ignored
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  const button = t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)
  // the rail's New menu (the old app's way): open it, then click the item
  const create = async item => { (await wait(() => tid('new-menu'), 'the New button')).click(); (await wait(() => tid(item), 'the menu item ' + item)).click() }
  const editorText = () => (document.querySelector('.ProseMirror') || {}).textContent || ''

  addEventListener('DOMContentLoaded', async () => {
    try {
      const phase = cfg.phase
      if (phase === 1) {
        // no server configured yet: the server form, then sign-up through the real form
        const form = await wait(() => tid('server-form'), 'server form')
        setVal(form.querySelector('input[name=server]'), cfg.server)
        form.requestSubmit()
        const auth = await wait(() => tid('auth-form'), 'auth form')
        button('حساب ندارم').click()
        setVal(auth.querySelector('input[name=username]'), cfg.user)
        setVal(auth.querySelector('input[name=password]'), cfg.password)
        await sleep(100)
        tid('auth-submit').click()
        await wait(() => tid('recovery'), 'recovery key')
        tid('ws-new').click()
        await wait(() => tid('new-menu'), 'workspace view')
        await create('new-page')
        await wait(() => document.querySelector('.ProseMirror') && window.__editor, 'editor')
        window.__editor.commands.insertContent('متن ماندگار پس از بستن')
        // close at ONCE: well inside the 300 ms throttle, so only the flush on close can save this text
        await log('CLOSING')
        await inv('ui_close')
      } else if (phase === 4) {
        // the all-blocks page in the REAL desktop WebView and under its CSP: KaTeX, Mermaid, code highlighting, Excalidraw from our own assets
        await wait(() => tid('ws-list'), 'the workspace list after a restart')
        tid('ws-list').querySelector('button').click()
        await wait(() => tid('new-menu'), 'the workspace view')
        await create('new-all-blocks')
        await wait(() => document.querySelector('.math-block .katex'), 'a rendered formula', 60000)
        await wait(() => document.querySelector('.mermaid-block svg'), 'a rendered diagram', 60000)
        await wait(() => document.querySelector('.code-block .hljs-keyword'), 'highlighted code', 20000)
        document.querySelector('.drawing-block .drawing-edit').click()
        await wait(() => document.querySelector('.drawing-overlay .excalidraw'), 'the drawing editor', 90000)
        document.querySelector('[data-testid=drawing-save]').click()
        await wait(() => !document.querySelector('.drawing-overlay'), 'the drawing editor closing')
        await sleep(800) // let the page reach the store before the window goes
        await inv('app_exit', { code: 0, report: 'UI-PHASE-4 ok: every block rendered in the desktop WebView under its CSP' })
      } else if (phase === 2) {
        // restart: no server form, no sign-in form: straight to the workspace list, then the page with its text
        await wait(() => tid('ws-list') || tid('auth-form') || tid('server-form'), 'a first screen')
        if (!tid('ws-list')) throw new Error('expected the workspace list after a restart, got ' + (tid('auth-form') ? 'the sign-in form' : 'the server form'))
        tid('ws-list').querySelector('button').click()
        const row = await wait(() => tid('page-row'), 'the page row')
        row.click()
        await wait(() => editorText().includes('متن ماندگار پس از بستن'), 'the text typed before closing')
        // sign out: the form returns
        tid('signout').click()
        await wait(() => tid('auth-form'), 'the sign-in form after signing out')
        await inv('app_exit', { code: 0, report: 'UI-PHASE-2 ok: restart kept the session, the text survived the close, sign-out shows the form' })
      } else {
        // after signing out and restarting: the sign-in form, not the workspace list
        await wait(() => tid('auth-form') || tid('ws-list') || tid('server-form'), 'a first screen')
        if (!tid('auth-form')) throw new Error('expected the sign-in form after sign-out + restart')
        await inv('app_exit', { code: 0, report: 'UI-PHASE-3 ok: the token was removed by sign-out' })
      }
    } catch (e) {
      await inv('app_exit', { code: 1, report: 'ui-test failed in phase ' + cfg.phase + ': ' + (e && e.message || e) + ' | screen: ' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) })
    }
  })
})()
