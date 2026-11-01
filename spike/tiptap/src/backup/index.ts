// Backup and restore. `format.ts` has the shared bits, `inspect.ts` reads and checks a file without writing,
// `web.ts` and `tauri.ts` are the two places notes can live. This file is the only one the app imports.
import { allFiles } from '../attachments'
import { freezeStorage, isTauri, thawStorage } from '../db'
import { t } from '../i18n'
import { toMarkdown } from '../markdown'
import { frontMatter } from '../meta'
import type { Page, PageRepo } from '../repo'
import { flushPreferences } from '../sharedPreferences'
import { saveBeforeUpdate } from '../updateSave'
import { BackupError, download, fileStamp, toBase64 } from './format'
import { inspectBackup, type BackupPlan } from './inspect'
import { applyTauri, buildTauri, type RestoreTo } from './tauri'
import { applyWeb, buildWeb } from './web'

export { BackupError, download, fileStamp, inspectBackup }
export type { BackupPlan, BackupSummary } from './inspect'
export type { RestoreTo } from './tauri'

const dataUri = async (src: string) => {
  if (!src.startsWith('att:')) return src
  const f = (await allFiles()).find((x) => x.id === src.slice(4))
  return f ? `data:${f.type};base64,${await toBase64(f.blob)}` : ''
}

export const pageToMarkdown = async (p: Page) => frontMatter(p) + (await toMarkdown(p.title, p.content, dataUri))

const settle = async (repo: PageRepo) => {
  await saveBeforeUpdate()
  await repo.flushBeforeUpdate()
  await flushPreferences()
}

/** Full backup as one JSON file (pages incl. trash + every attachment). */
export async function buildBackup(repo: PageRepo): Promise<Blob> {
  await settle(repo)
  return isTauri ? buildTauri() : buildWeb(repo)
}

/** Set before the page reloads so the next load can say what happened. */
export const RESTORED_KEY = 'nevis-restored'
export interface Restored {
  pages: number
  files: number
  copy?: string
}

/**
 * Applies a checked backup. In the browser every page is replaced, so a copy of the current notes is downloaded first and
 * the restore stops if that fails; on desktop the backup opens as a new vault and nothing is replaced.
 */
export async function restoreBackup(repo: PageRepo, plan: BackupPlan, opts: { saveCopy?: boolean } & RestoreTo = {}): Promise<Restored> {
  await settle(repo)
  let copy: string | undefined
  if (!isTauri && opts.saveCopy !== false) {
    copy = `notes-before-restore-${fileStamp()}.json`
    try {
      download(copy, await buildWeb(repo))
    } catch (e) {
      throw new BackupError(t('Could not save a copy of your current notes, so nothing was restored.'))
    }
  }
  let result: { pages: number; files: number; copy?: string }
  if (isTauri) {
    freezeStorage()
    try {
      result = await applyTauri(plan, opts)
    } catch (e) {
      thawStorage()
      throw e
    }
  } else {
    await applyWeb(repo, plan)
    result = { pages: plan.summary.pages + plan.summary.folders, files: plan.summary.files }
  }
  const restored: Restored = { ...result, copy: result.copy ?? copy }
  try {
    sessionStorage.setItem(RESTORED_KEY, JSON.stringify(restored))
  } catch {
    /* the toast is a courtesy */
  }
  window.location.reload()
  return restored
}

/** Reads what a restore left for this load (once). */
export function takeRestored(): Restored | null {
  try {
    const raw = sessionStorage.getItem(RESTORED_KEY)
    if (!raw) return null
    sessionStorage.removeItem(RESTORED_KEY)
    return JSON.parse(raw) as Restored
  } catch {
    return null
  }
}
