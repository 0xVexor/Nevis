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
        await wait(() => tid('new-page'), 'workspace view')
        tid('new-page').click()
        await wait(() => document.querySelector('.ProseMirror') && window.__editor, 'editor')
        window.__editor.commands.insertContent('متن ماندگار پس از بستن')
        // close at ONCE: well inside the 300 ms throttle, so only the flush on close can save this text
        await log('CLOSING')
        await inv('ui_close')
      } else if (phase === 2) {
        // restart: no server form, no sign-in form: straight to the workspace list, then the page with its text
        await wait(() => tid('ws-list') || tid('auth-form') || tid('server-form'), 'a first screen')
        if (!tid('ws-list')) throw new Error('expected the workspace list after a restart, got ' + (tid('auth-form') ? 'the sign-in form' : 'the server form'))
        tid('ws-list').querySelector('button').click()
        const row = await wait(() => tid('page-row'), 'the page row')
        row.querySelectorAll('button')[1].click()
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
