import { invoke } from '@tauri-apps/api/core'
import { repo } from './store'
import { saveBeforeUpdate } from './updateSave'
import { flushPreferences } from './sharedPreferences'
import { syncNow, accountStatus } from './db'

export interface SyncConflict { id: string; path: string; createdAt: number; deleted?: boolean; provider?: 'drive' | 'github'; base: string | null; local: string | null; remote: string | null }
export const githubAction = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>('github_action', { action, args })
export async function saveForSync() { await saveBeforeUpdate(); await repo.flushBeforeUpdate(); await flushPreferences() }
export async function syncWorkspaceNow() { await saveForSync(); await syncNow() }
export const openConflictReview = () => window.dispatchEvent(new Event('github-review-conflicts'))

export async function conflictAction<T>(action: string, args: Record<string, unknown> = {}): Promise<T> { const st = await accountStatus(); return invoke<T>(st.provider === 'drive' ? 'drive_action' : 'github_action', { action, args }) }
