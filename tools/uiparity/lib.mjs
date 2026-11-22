import { chromium } from '@playwright/test'
import { PAGES, docOf } from './fixture.mjs'

const OLD = process.env.OLD ?? 'http://localhost:5190', NEW = process.env.NEW ?? 'http://localhost:5174'
export const VIEW = { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) }
const LANG = process.env.LANG_UI ?? 'fa', SCHEME = process.env.SCHEME ?? 'light'
// both apps keep their look in localStorage; the same language and theme go into each
const THEME = process.env.THEME ?? 'light'

/** The old app: the fixture goes into the legacy localStorage key (the old app migrates it on first start). */
export const browser = await chromium.launch({ channel: 'chrome' })
export async function openOld() {
  const ctx = await browser.newContext({ viewport: VIEW, colorScheme: SCHEME })
  const ids = Object.fromEntries(PAGES.map(p => [p.key, crypto.randomUUID()]))
  const now = Date.now()
  const pages = PAGES.map((p, i) => ({ id: ids[p.key], parentId: p.parent ? ids[p.parent] : null, title: p.title, icon: p.icon || undefined, tags: p.tags, status: p.status || undefined, favorite: p.favorite, sort: i, content: docOf(p, ids, 'old'), updatedAt: now - i * 3_600_000, deletedAt: null }))
  await ctx.addInitScript(([pg, lang, THEME_]) => {
    if (!localStorage.getItem('__seeded')) { localStorage.setItem('not.pages.v1', JSON.stringify(pg)); localStorage.setItem('not.settings', JSON.stringify({ lang, theme: THEME_ })); localStorage.setItem('__seeded', '1') }
  }, [pages, LANG, THEME])
  const page = await ctx.newPage(); await page.goto(OLD)
  await page.locator('#root > *').first().waitFor(); await page.waitForTimeout(2500)
  return { ctx, page, ids }
}

/** The new app: a real account on the real server, then the fixture through the workspace API. */
export async function openNew() {
  const ctx = await browser.newContext({ viewport: VIEW, colorScheme: SCHEME })
  await ctx.addInitScript(([lang, theme]) => { if (!localStorage.getItem('nevis.device')) localStorage.setItem('nevis.device', JSON.stringify({ lang, theme })) }, [LANG, THEME])
  const page = await ctx.newPage(); await page.goto(NEW)
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill('par' + Date.now().toString(36))
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click(); await page.getByTestId('recovery').waitFor()
  await page.getByTestId('ws-new').click(); await page.waitForFunction(() => !!window.__ws?.rt?.client)
  const ids = {}
  for (const p of PAGES) {
    ids[p.key] = await page.evaluate(async ([p, parent]) => {
      const ws = window.__ws; const id = await ws.newPage(parent, p.title)
      await ws.setMeta(id, { icon: p.icon, favorite: p.favorite, status: p.status })
      for (const t of p.tags) await ws.tagPageByName(id, t, true)
      return id
    }, [p, p.parent ? ids[p.parent] : ''])
  }
  for (const p of PAGES) await page.evaluate(async ([id, json]) => window.__ws.writeBody(id, json), [ids[p.key], docOf(p, ids, 'new')])
  await page.waitForTimeout(1500)
  return { ctx, page, ids }
}

