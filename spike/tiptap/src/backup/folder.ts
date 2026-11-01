// A backup as a folder (desktop only): the workspace's own files, one per page, with a manifest. The Rust side writes only what
// changed, checks every file after writing it and refuses to read a folder whose files do not match the manifest.
import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'
import { BackupError } from './format'
import { inspectBackup, type BackupPlan } from './inspect'

/** What a backup holds. `pages` includes the trashed ones and not the folders. */
export interface FolderCounts {
  pages: number
  folders: number
  trashed: number
  files: number
  databases: number
}
export interface FolderReport {
  path: string
  counts: FolderCounts
  created_at: number
  written: number
  removed: number
}

/** The backup was not written because the workspace holds far fewer pages than its last backup. `force` overrides it. */
export class BackupBlocked extends BackupError {}

/** The desktop side fails with `BACKUP:<code>`. */
function explain(e: unknown): unknown {
  const code = String((e as Error)?.message ?? e).match(/BACKUP:(\w+)/)?.[1]
  switch (code) {
    case 'page_count_dropped':
      return new BackupBlocked(t('This workspace has far fewer pages than its last backup, so the backup was not overwritten.'))
    case 'verification_failed':
      return new BackupError(t('The backup failed verification.'))
    case 'missing_file':
      return new BackupError(t('A file the backup lists is missing.'))
    case 'invalid_format':
      return new BackupError(t('This folder is not a Nevis backup.'))
    case 'destination_inside_live_data':
      return new BackupError(t('Choose a folder outside the workspace.'))
    default:
      return e
  }
}

/** Brings this workspace's folder inside `dir` up to date. `force` writes even when far fewer pages are left than before. */
export async function saveFolder(dir: string, force = false): Promise<FolderReport> {
  try {
    return await invoke<FolderReport>('vault_backup_folder_save', { dir, force })
  } catch (e) {
    throw explain(e)
  }
}

/** Reads and checks a backup folder (the workspace's folder inside the backup directory). Nothing is written. */
export async function readFolder(dir: string): Promise<BackupPlan> {
  let data: unknown
  try {
    data = await invoke('vault_backup_folder_read', { dir })
  } catch (e) {
    throw explain(e)
  }
  return inspectBackup(JSON.stringify(data))
}
