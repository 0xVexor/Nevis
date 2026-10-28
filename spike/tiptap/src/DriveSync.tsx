import { driveSettingKeys, driveSettingLabels, type SettingsPolicy } from './driveSettingsPolicy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { open as chooseFolder } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { saveForSync, openConflictReview, syncWorkspaceNow } from './syncActions'
import { accountStatus, type AccountStatus } from './db'
import { enableDriveBlockIds } from './editor/stableBlockIds'
import { t } from './i18n'
import { repo } from './store'
import './styles/github-sync.css'

const driveAction = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>('drive_action', { action, args })
interface DriveStatus {
  driveSyncEnabled: boolean; releaseReady: boolean
  auth: { configured: boolean; signedIn: boolean; email?: string; subject?: string }
  binding: { vaultId: string; folderId: string; paused: boolean; backup: string } | null
  settingsPolicy?: SettingsPolicy
  pending: number; lastVerifiedAt: number; metrics: Record<string, unknown> | null; gc: Record<string, unknown> | null
}
interface RemoteVault { id: string; folderId: string; name: string }
interface RestorePoint { id: string; checkpointId: string; createdAt: number; files: number }
const explain = (e: unknown) => {
  const code = String(e).replace(/^DRIVE:/, '')
  const messages: Record<string, string> = {
    oauth_not_configured: 'Google OAuth is not configured in this build. See GOOGLE_SETUP.md.',
    feature_disabled: 'Drive sync is disabled in this build because release checks are incomplete.',
    sign_in_required: 'Google authorization expired or was revoked. Sign in again. Pending changes are kept.',
    account_mismatch: 'This workspace belongs to another Google account. Reconnect with its original account.',
    secure_storage_unavailable: 'The operating system credential store is unavailable. No token was saved to a file.',
    remote_unavailable: 'The remote file or folder is unavailable. Local data is kept. Check access before retrying.',
    pending_outbox: 'Publish pending changes before changing the provider.',
    pending_local_edits: 'Save and sync local changes before changing the provider or creating a restore point.',
    duplicate_roots: 'Multiple Nevis roots were found. Sync stopped; no folder was chosen automatically.',
    storage_full: 'Google Drive storage is full. Local changes remain on this device.',
    network: 'Google Drive is unreachable. Local saves continue independently.',
  }
  if (code.startsWith('rate_limited:')) return t('Google Drive rate limit reached. Retry will respect the required delay.')
  return t(messages[code] ?? String(e))
}
export function DriveAccountDialog({ onClose, onGitHub }: { onClose: () => void; onGitHub: () => void }) {
  const root = useRef<HTMLElement>(null)
  const [st, setSt] = useState<DriveStatus | null>(null)
  const [runtime, setRuntime] = useState<AccountStatus | null>(null)
  const [busy, setBusy] = useState(false), [waiting, setWaiting] = useState(false)
  const [error, setError] = useState(''), [note, setNote] = useState('')
  const [vaults, setVaults] = useState<RemoteVault[]>([]), [history, setHistory] = useState<RestorePoint[]>([])
  const refresh = useCallback(async () => {
    const [status, runtime] = await Promise.all([driveAction<DriveStatus>('status'), accountStatus()])
    setSt(status); setRuntime(runtime); enableDriveBlockIds(runtime.provider === 'drive')
  }, [])
  useEffect(() => { void refresh().catch(e => setError(explain(e))); const id = window.setInterval(() => void refresh().catch(e => setError(explain(e))), 2000); return () => clearInterval(id) }, [refresh])
  useEffect(() => {
    if (!waiting) return
    let live = true, polling = false
    const id = window.setInterval(async () => {
      if (polling) return
      polling = true
      try { const r = await driveAction<{ waiting?: boolean }>('poll'); if (live && !r.waiting) { setWaiting(false); await refresh() } }
      catch (e) { if (live) { setError(explain(e)); setWaiting(false) } } finally { polling = false }
    }, 1000)
    return () => { live = false; clearInterval(id) }
  }, [waiting, refresh])
  const run = async (f: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setNote('')
    try { await f(); await refresh() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }
  const close = () => { if (waiting) void driveAction('cancel'); onClose() }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); if (waiting) void driveAction('cancel'); onClose() }
      if (e.key === 'Tab') {
        const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary,select,input') ?? [])]
        const first = nodes[0], last = nodes.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose, waiting])
  const folder = () => chooseFolder({ directory: true, multiple: false })
  const connect = () => run(async () => {
    await saveForSync()
    const result = await driveAction<{ backup: string }>('connect')
    enableDriveBlockIds(true)
    await repo.refreshFromStore()
    setNote(`${t('Verified backup')}: ${result.backup}`)
    window.dispatchEvent(new Event('data-changed'))
  })
  return <div className="overlay" onMouseDown={e => e.target === e.currentTarget && close()}>
    <section ref={root} className="modal wsd acct gh-dialog drive-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-title">
      <header className="wsd-head"><h2 id="drive-title">Google Drive Sync</h2><button className="icon-btn" onClick={close} aria-label={t('Close')}>×</button></header>
      <div className="wsd-body gh-body">
        <p>{t('Local saves work offline. Sync uses your personal Google Drive. End-to-end encryption is not available.')}</p>
        <p className="gh-notice" role="status">{t('Experimental — not ready for real vaults until release checks pass.')}</p>
        {error && <p className="acct-err" role="alert">{error}</p>}{note && <p role="status">{note}</p>}
        {!st ? <p>{t('Loading…')}</p> : <>
          {!st.driveSyncEnabled && <p>{t('Drive sync is disabled in this build because release checks are incomplete.')}</p>}
          {!st.auth.configured && <p>{t('Google OAuth is not configured in this build. See GOOGLE_SETUP.md.')}</p>}
          <p>{st.auth.email ?? t('Signed out')}</p>
          <div className="acct-row">
            <button disabled={busy || waiting || !st.driveSyncEnabled || !st.auth.configured} onClick={() => void run(async () => { await driveAction('begin'); setWaiting(true) })}>{st.auth.signedIn ? t('Reconnect Google') : t('Sign in with Google')}</button>
            {waiting && <button onClick={() => void run(async () => { await driveAction('cancel'); setWaiting(false) })}>{t('Cancel')}</button>}
          </div>
          {st.auth.signedIn && <>
            {!st.binding && <button disabled={busy || !st.driveSyncEnabled} onClick={() => void connect()}>{t('Back up and connect this workspace to Drive')}</button>}
            {st.binding && <>
              <p dir="ltr">Vault: {st.binding.vaultId}</p>
              <p role="status">{st.binding.paused ? t('Paused') : runtime?.state === 'syncing' ? t('Syncing…') : runtime?.state === 'pending' ? t('Saved locally — waiting to sync') : runtime?.reason === 'CONFLICTS' ? t('Conflicts') : runtime?.error ? explain(runtime.error) : st.lastVerifiedAt ? `${t('Last verified')}: ${new Date(st.lastVerifiedAt).toLocaleString()}` : t('Waiting to sync')}</p>
              <p>{t('Pending batches')}: {st.pending}</p>
              <div className="acct-row">
                <button disabled={busy || runtime?.state === 'syncing' || st.binding.paused} onClick={() => void run(syncWorkspaceNow)}>{t('Sync now')}</button>
                <button disabled={busy} onClick={() => void run(() => driveAction('pause', { paused: !st.binding?.paused }))}>{st.binding.paused ? t('Resume sync') : t('Pause sync')}</button>
                <button disabled={busy} onClick={() => { close(); openConflictReview() }}>{t('Review conflicts')}</button>
              </div>
              <details><summary>{t('Settings sync policy')}</summary>
                <p>{t('Global values sync between devices. Device-local values stay on this installation; previously uploaded history is retained.')}</p>
                {driveSettingKeys.map(key => <label className="gh-policy" key={key}><span>{t(driveSettingLabels[key])}</span><select aria-label={`${t('Sync scope')}: ${t(driveSettingLabels[key])}`} value={st.settingsPolicy?.[key] ?? 'global'} disabled={busy} onChange={e => { const scope = e.target.value; void run(async () => { await saveForSync(); await driveAction('settings-policy', { key, scope }) }) }}><option value="global">{t('Global')}</option><option value="device-local">{t('Device-local')}</option></select></label>)}
              </details>
              <div className="acct-row">
                <button disabled={busy} onClick={() => void run(() => driveAction('checkpoint'))}>{t('Create restore point')}</button>
                <button disabled={busy} onClick={() => void run(async () => setHistory(await driveAction<RestorePoint[]>('history')))}>{t('Remote restore points')}</button>
              </div>
              {history.map(h => <div key={h.id}><span>{new Date(h.createdAt).toLocaleString()} · {h.files} {t('files')}</span><button disabled={busy} onClick={() => void run(async () => { await saveForSync(); const parent = await folder(); if (typeof parent === 'string') { await driveAction('restore-copy', { checkpointId: h.id, parent }); window.location.reload() } })}>{t('Restore as a new local copy')}</button></div>)}
              <button disabled={busy} onClick={() => void run(async () => { await saveForSync(); await driveAction('detach') })}>{t('Use local only (requires no pending changes)')}</button>
            </>}
            <button disabled={busy || !st.driveSyncEnabled} onClick={() => void run(async () => setVaults(await driveAction<RemoteVault[]>('list')))}>{t('Find my Drive workspaces')}</button>
            {vaults.map(v => <div key={v.folderId}><span>{v.name}</span><button disabled={busy || v.id === st.binding?.vaultId} onClick={() => void run(async () => { await saveForSync(); const parent = await folder(); if (typeof parent === 'string') { await driveAction('download', { ...v, parent }); window.location.reload() } })}>{t('Download to a new folder')}</button></div>)}
            <button disabled={busy} onClick={() => void run(() => driveAction('disconnect'))}>{t('Disconnect Google (keep local data)')}</button>
          </>}
          <details><summary>{t('Sync diagnostics')}</summary>{st.binding && <div className="acct-row"><button disabled={busy} onClick={() => void run(async () => { const result=await driveAction('deep-check'); setNote(JSON.stringify(result,null,2)) })}>{t('Verify all local file bytes')}</button><button disabled={busy} onClick={() => void run(async () => { const result=await driveAction('gc-dry-run'); setNote(JSON.stringify(result,null,2)) })}>{t('Check cleanup safety (no deletion)')}</button><button disabled={busy} onClick={() => void run(async () => { const result=await driveAction('gc-verify'); setNote(JSON.stringify(result,null,2)) })}>{t('Verify cleanup assessment')}</button></div>}<pre dir="ltr">{JSON.stringify({ pending: st.pending, metrics: st.metrics, gc: st.gc, releaseReady: st.releaseReady }, null, 2)}</pre></details>
        </>}
        <button disabled={busy || waiting} onClick={onGitHub}>{t('GitHub / legacy sync settings')}</button>
      </div>
    </section>
  </div>
}
