import type { BrowserContext, Page } from '@playwright/test'
import type { Lab, Status } from '../src/lab'

export const newWs = () => crypto.randomUUID()
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type W = { __lab: Lab; __labReady: Promise<void> }

export async function open(ctx: BrowserContext, ws: string): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(`/?ws=${ws}`)
  await page.evaluate(() => (window as unknown as W).__labReady)
  return page
}

export const status = (page: Page): Promise<Status> => page.evaluate(() => (window as unknown as W).__lab.status())
export const headOf = (page: Page, ws: string): Promise<number> => page.evaluate(async w => (await (await fetch(`/v1/ws/${w}/ops?after=0&limit=1`, { headers: { Authorization: 'Bearer dev' } })).json()).head as number, ws)

/** Until this tab has sent everything, received everything the server has, and applied it. */
export async function settle(page: Page, ws: string, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const [s, head] = await Promise.all([status(page), headOf(page, ws)])
    if (s.outbox === 0 && s.inbox === 0 && s.cursor === head && s.leader) return s
    if (Date.now() - t0 > timeoutMs) throw new Error(`did not settle: ${JSON.stringify(s)} head ${head}`)
    await sleep(100)
  }
}

export const projection = (page: Page): Promise<string> => page.evaluate(async () => JSON.stringify(await (window as unknown as W).__lab.projection()))
