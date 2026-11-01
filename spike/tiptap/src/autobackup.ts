import { isTauri, kvGet, kvSet } from './db'
import { BackupBlocked, buildBackup, saveFolder, type FolderCounts } from './backup'
import { saveWorkspace } from './saveWorkspace'
import { repo } from './store'

/**
 * One backup, taken by hand ("Back up now") or by itself ("Automatic"), into a folder the person picks.
 * - Desktop: the workspace's own files, one per page, in `<folder>/<workspace> [<id>]/`; only what changed is written.
 * - Browser (File System Access API, Chromium/Edge): `notes-backup-latest.json` after changes (at most every MIN_GAP) and
 *   when the tab is hidden, and `notes-backup-YYYY-MM-DD.json` holding the day's last state; the newest KEEP_DAILY are kept.
 * Restoring is the normal restore flow with the folder or any of these files.
 */

const MIN_GAP = 2 * 60 * 1000
const KEEP_DAILY = 14
const LATEST = 'notes-backup-latest.json'
const DAILY = /^notes-backup-(\d{4}-\d{2}-\d{2})\.json$/
const DEVICE_KEY = 'nevis-backup' // desktop: the folder is a path on this computer, so it is kept here, not in the workspace

interface Cfg {
  /** Automatic backup is on. A backup by hand works whenever a folder is chosen. */
  enabled: boolean
  lastAt?: number
  lastDaily?: string
  counts?: FolderCounts
  dir?: string // desktop only
  error?: string // 'NEEDS_PERMISSION' or a message
  blocked?: boolean // the last backup was held back because pages suddenly went missing
}

type Dir = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

export interface BackupStatus {
  supported: boolean
  /** A folder is chosen, so a backup can be taken. */
  ready: boolean
  /** Automatic backup is on. */
  enabled: boolean
  folder?: string
  lastAt?: number
  counts?: FolderCounts
  error?: string
  blocked: boolean
}

let handle: Dir | null = null
let cfg: Cfg = { enabled: false }
let timer = 0
let running = false
let manual = false // a backup by hand runs even when automatic backup is off

const emit = () => void window.dispatchEvent(new Event('backup-status'))
const persistCfg = async () => {
  if (!isTauri) return kvSet('backupCfg', cfg)
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(cfg))
  } catch {
    /* the folder is asked for again */
  }
}
const loadCfg = async (): Promise<Cfg> => {
  if (!isTauri) return (await kvGet<Cfg>('backupCfg')) ?? { enabled: false }
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') ?? { enabled: false }
  } catch {
    return { enabled: false }
  }
}

export const backupSupported = () => isTauri || 'showDirectoryPicker' in window
const ready = () => (isTauri ? !!cfg.dir : !!handle)

export function backupStatus(): BackupStatus {
  return {
    supported: backupSupported(),
    ready: ready(),
    enabled: cfg.enabled && ready(),
    folder: isTauri ? cfg.dir : handle?.name,
    lastAt: cfg.lastAt,
    counts: cfg.counts,
    error: cfg.error,
    blocked: !!cfg.blocked,
  }
}

export async function initBackup() {
  if (!isTauri) handle = ((await kvGet<Dir>('backupDir')) ?? null) as Dir | null
  cfg = await loadCfg()
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
  for await (const [name] of dir.entries()) if (DAILY.test(name)) names.push(name)
  names.sort()
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_DAILY))) await dir.removeEntry(old).catch(() => {})
}

/** The browser build: the whole workspace as one file, plus the day's file. */
async function backupToFiles(dir: Dir) {
  const blob = await buildBackup(repo)
  await write(dir, LATEST, blob)
  // the day's file is rewritten on every backup, so it always holds the last state of that day, not the first
  await write(dir, `notes-backup-${today()}.json`, blob)
  if (cfg.lastDaily !== today()) {
    cfg.lastDaily = today()
    await prune(dir)
  }
  cfg.counts = undefined
}

/** `force`: write even when far fewer pages are left than in the last backup (after the person said so). */
async function runBackup(force = false): Promise<void> {
  if (!ready() || running) return
  if (!force && !cfg.enabled && !manual) return // nothing asks for it
  if (!isTauri && (await handle!.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
    cfg.error = 'NEEDS_PERMISSION'
    return emit()
  }
  running = true
  try {
    await repo.flushed()
    if (isTauri) {
      await saveWorkspace()
      const r = await saveFolder(cfg.dir!, force)
      cfg.counts = r.counts
      cfg.lastAt = r.created_at
    } else {
      await backupToFiles(handle!)
      cfg.lastAt = Date.now()
    }
    cfg.error = undefined
    cfg.blocked = false
  } catch (e) {
    console.error('auto-backup', e)
    cfg.error = String((e as Error)?.message ?? e)
    cfg.blocked = e instanceof BackupBlocked
  } finally {
    running = false
    await persistCfg().catch(() => {})
    emit()
  }
}

/** Must be called from a click: opens the folder picker. */
export async function chooseBackupFolder() {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const dir = await open({ directory: true, title: undefined })
    if (typeof dir === 'string') await configureBackupFolder({ dir })
    return
  }
  const picked = await window.showDirectoryPicker({ id: 'notes-backup', mode: 'readwrite' }).catch(() => null)
  if (picked) await configureBackupFolder({ handle: picked })
}

/** Also the seam for tests: any FileSystemDirectoryHandle (e.g. from the origin-private file system) works. */
async function configureBackupFolder(to: { dir: string } | { handle: FileSystemDirectoryHandle }) {
  if ('dir' in to) cfg = { enabled: true, dir: to.dir }
  else {
    handle = to.handle as Dir
    cfg = { enabled: true }
    await kvSet('backupDir', to.handle)
  }
  await persistCfg()
  await runBackup()
}

/** After a browser restart the permission may need a fresh click. */
export async function grantAccess() {
  if (handle && (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted') await runBackup()
  emit()
}

/** Automatic backup on or off. The folder and the files already in it stay. */
export async function setAutomatic(on: boolean) {
  cfg.enabled = on
  cfg.error = undefined
  await persistCfg()
  emit()
  if (on) await runBackup()
}

/** Back up now, whether or not automatic backup is on. */
export async function backupNow(force = false) {
  manual = true
  try {
    await runBackup(force)
  } finally {
    manual = false
  }
}
