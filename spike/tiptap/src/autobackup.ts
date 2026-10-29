import { kvGet, kvSet } from './db'
import { buildBackup } from './backup'
import { repo } from './store'

/**
 * Automatic backup into a folder the user picks (File System Access API, Chromium/Edge).
 * - `notes-backup-latest.json` is rewritten after changes (at most every MIN_GAP) and when the tab is hidden
 * - `notes-backup-YYYY-MM-DD.json` is written once per day; the newest KEEP_DAILY are kept
 * Restoring is the normal "restore from backup" flow with any of these files.
 */

const MIN_GAP = 2 * 60 * 1000
const KEEP_DAILY = 14
const LATEST = 'notes-backup-latest.json'
const DAILY = /^notes-backup-(\d{4}-\d{2}-\d{2})\.json$/

interface Cfg {
  enabled: boolean
  lastAt?: number
  lastDaily?: string
  error?: string // 'NEEDS_PERMISSION' or a message
}

type Dir = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

interface BackupStatus {
  supported: boolean
  enabled: boolean
  folder?: string
  lastAt?: number
  error?: string
}

let handle: Dir | null = null
let cfg: Cfg = { enabled: false }
let timer = 0
let running = false

const emit = () => void window.dispatchEvent(new Event('backup-status'))
const persistCfg = () => kvSet('backupCfg', cfg)

export const backupSupported = () => 'showDirectoryPicker' in window

export function backupStatus(): BackupStatus {
  return { supported: backupSupported(), enabled: cfg.enabled, folder: handle?.name, lastAt: cfg.lastAt, error: cfg.error }
}

export async function initBackup() {
  handle = ((await kvGet<Dir>('backupDir')) ?? null) as Dir | null
  cfg = (await kvGet<Cfg>('backupCfg')) ?? { enabled: false }
  window.addEventListener('data-changed', schedule)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void runBackup()
  })
  emit()
  if (cfg.enabled) void runBackup() // also writes the day's file when the app is opened on a new day
}

function schedule() {
  if (!cfg.enabled || timer) return
  timer = window.setTimeout(() => {
    timer = 0
    void runBackup()
  }, MIN_GAP)
}

const today = () => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD in local time

async function write(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
  await w.write(blob)
  await w.close() // the browser swaps the file in on close, so a crash never leaves a half-written backup
}

async function prune(dir: FileSystemDirectoryHandle) {
  const names: string[] = []
  for await (const [name] of (dir as any).entries() as AsyncIterable<[string, unknown]>) if (DAILY.test(name)) names.push(name)
  names.sort()
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_DAILY))) await dir.removeEntry(old).catch(() => {})
}

async function runBackup(): Promise<void> {
  if (!cfg.enabled || !handle || running) return
  if ((await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
    cfg.error = 'NEEDS_PERMISSION'
    return emit()
  }
  running = true
  try {
    await repo.flushed()
    const blob = await buildBackup(repo)
    await write(handle, LATEST, blob)
    if (cfg.lastDaily !== today()) {
      await write(handle, `notes-backup-${today()}.json`, blob)
      cfg.lastDaily = today()
      await prune(handle)
    }
    cfg.lastAt = Date.now()
    cfg.error = undefined
  } catch (e) {
    console.error('auto-backup', e)
    cfg.error = String((e as Error)?.message ?? e)
  } finally {
    running = false
    await persistCfg().catch(() => {})
    emit()
  }
}

/** Must be called from a click: opens the folder picker. */
export async function chooseBackupFolder() {
  const picked = await (window as any).showDirectoryPicker({ id: 'notes-backup', mode: 'readwrite' }).catch(() => null)
  if (picked) await configureBackupFolder(picked)
}

/** Also the seam for tests: any FileSystemDirectoryHandle (e.g. from the origin-private file system) works. */
async function configureBackupFolder(dir: FileSystemDirectoryHandle) {
  handle = dir as Dir
  cfg = { enabled: true }
  await kvSet('backupDir', dir)
  await persistCfg()
  await runBackup()
}

/** After a browser restart the permission may need a fresh click. */
export async function grantAccess() {
  if (handle && (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted') await runBackup()
  emit()
}

export async function disableBackup() {
  cfg.enabled = false
  cfg.error = undefined
  await persistCfg()
  emit()
}

export const backupNow = () => runBackup()
