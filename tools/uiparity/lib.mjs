import { chromium } from '@playwright/test'
import { PAGES, docOf } from './fixture.mjs'

const OLD = process.env.OLD ?? 'http://localhost:5190', NEW = process.env.NEW ?? 'http://localhost:5174'
export const VIEW = { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) }
const LANG = process.env.LANG_UI ?? 'fa', SCHEME = process.env.SCHEME ?? 'light'
// both apps keep their look in localStorage; the same language and theme go into each
const THEME = process.env.THEME ?? 'light'
const IDS = Object.fromEntries(PAGES.map(p => [p.key, crypto.randomUUID()]))
const NOW = Date.now()

/** The old app: the fixture goes into the legacy localStorage key (the old app migrates it on first start). */
export const browser = await chromium.launch({ channel: 'chrome' })
export async function openOld() {
  const ctx = await browser.newContext({ viewport: VIEW, colorScheme: SCHEME })
  const ids = IDS
  const now = NOW
  const pages = PAGES.map((p, i) => ({ id: ids[p.key], parentId: p.parent ? ids[p.parent] : null, title: p.title, icon: p.icon || undefined, tags: p.tags, status: p.status || undefined, favorite: p.favorite, sort: i, content: docOf(p, ids, 'old'), updatedAt: now - i * 3_600_000, deletedAt: null }))
  await ctx.addInitScript(([pg, lang, THEME_]) => {
    if (!localStorage.getItem('__seeded')) { localStorage.setItem('not.pages.v1', JSON.stringify(pg)); localStorage.setItem('not.settings', JSON.stringify({ lang, theme: THEME_ })); localStorage.setItem('__seeded', '1') }
  }, [pages, LANG, THEME])
  await ctx.addInitScript(() => { Math.random = () => 0.42 })
  const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(NOW)); await page.goto(OLD)
  await page.locator('#root > *').first().waitFor(); await page.waitForTimeout(2500)
  return { ctx, page, ids }
}

/** The new app: a real account on the real server, then the fixture through the workspace API. */
export async function openNew() {
  const ctx = await browser.newContext({ viewport: VIEW, colorScheme: SCHEME })
  await ctx.addInitScript(([lang, theme]) => { if (!localStorage.getItem('nevis.device')) localStorage.setItem('nevis.device', JSON.stringify({ lang, theme })) }, [LANG, THEME])
  await ctx.addInitScript(() => { Math.random = () => 0.42 })
  const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(NOW)); await page.goto(NEW)
  await page.getByTestId('auth-switch').click()
  await page.locator('input[name=username]').fill('par' + Date.now().toString(36))
  await page.locator('input[name=password]').fill('correct horse battery')
  await page.getByTestId('auth-submit').click(); await page.getByTestId('recovery').waitFor()
  await page.getByTestId('ws-new').click(); await page.waitForFunction(() => !!window.__ws?.rt?.client)
  const ids = IDS
  for (const [index, p] of PAGES.entries()) {
    await page.evaluate(async ([p, parent, id, index, now]) => {
      const ws = window.__ws
      await ws.rt.client.setFields(id, { title: p.title, parent, sortKey: 'a' + String(index).padStart(4, '0'), trashed: false, kind: 'doc', createdAt: now - 86_400_000 + index * 1000 }, 'page')
      await ws.wrote(id)
      await ws.setMeta(id, { icon: p.icon, favorite: p.favorite, status: p.status })
      for (const t of p.tags) await ws.tagPageByName(id, t, true)
      return id
    }, [p, p.parent ? ids[p.parent] : '', ids[p.key], index, NOW])
  }
  for (const p of PAGES) await page.evaluate(async ([id, json]) => window.__ws.writeBody(id, json), [ids[p.key], docOf(p, ids, 'new')])
  await page.waitForTimeout(1500)
  // The UI reads recency from the derived index. Seed its persisted timestamps through the store,
  // then reload that index normally; otherwise indexing five new pages makes them all "edited now".
  await page.waitForFunction(ids => Object.values(ids).every(id => window.__ws.search.excerptOf(id)), ids)
  await page.evaluate(async ([ids, now]) => {
    const ws = window.__ws
    await ws.search.save()
    await ws.rt.store.run(async tx => {
      const saved = JSON.parse(await tx.getMeta('derived_pages'))
      Object.values(ids).forEach((id, i) => { saved.pages[id].at = now - i * 3_600_000 })
      await tx.setMeta('derived_pages', JSON.stringify(saved))
    })
    await ws.search.start(ws.data.pages)
  }, [ids, NOW])
  return { ctx, page, ids }
}

