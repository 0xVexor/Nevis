import { useCallback, useEffect, useRef, useState } from 'react'
import { open as chooseFolder } from '@tauri-apps/plugin-dialog'
import { accountStatus, syncNow, syncSet, type AccountStatus } from './db'
import { githubAction as action, saveForSync as durable, openConflictReview, type SyncConflict as Conflict } from './syncActions'
import { t, locale } from './i18n'
import * as Ic from './icons'
import './styles/github-sync.css'

interface Binding { owner: string; repo: string; branch: string; vault: string; repo_id: number; backup: string; quiet_seconds: number; poll_seconds: number }
interface Status { configured: boolean; signedIn: boolean; login: string | null; binding: Binding | null; installationUrl: string | null }
interface Device { userCode: string; verificationUri: string; interval: number; expiresIn: number }
interface RemoteVault { id: string; name?: string; files: number; connectedHere: boolean }
const messages: Record<string, string> = {
  repository_name_unavailable: 'This repository name is unavailable. Choose Use existing repository if it was already created, or enter another name.',
  app_not_configured: 'This build needs a GitHub App client ID. See the GitHub sync setup guide.',
  secure_storage_unavailable: 'The system credential store is unavailable. Enable it and sign in again. No token was written to a file.',
  sign_in_required: 'Your GitHub authorization expired or was revoked. Sign in again to continue.',
  permission_or_branch_policy: 'GitHub refused this operation. Check the selected repository permissions and branch rules, then retry.',
  not_found_or_access_revoked: 'The repository is unavailable. Check the account and App installation. Local data is safe.',
  repository_identity_or_privacy_changed: 'Sync stopped because the repository identity or privacy changed. Make it private and check access before retrying.',
  network_connect: 'The desktop app could not connect to GitHub. Check the system proxy or VPN and retry.',
  network_timeout: 'GitHub did not respond in time. Your notes are safe. Check whether the repository was already created before retrying.',
  network_dns: 'This device could not resolve the GitHub address. Check DNS, VPN or proxy settings.',
  network_proxy: 'The system proxy could not connect to GitHub. Check the proxy or VPN and retry.',
  network_tls: 'The secure GitHub connection could not be verified. Check the system clock and trusted certificates. Certificate checks remain enabled.',
  network_client_config: 'The native network client could not be initialized. Check the error details.',
  installation_required: 'Your account is signed in, but the App cannot access this repository. Grant access to the selected repository in GitHub, then continue with the existing repository.',
  repository_creation_uncertain: 'GitHub did not confirm repository creation. The repository may already exist. Check GitHub and continue with the existing repository if it was created. No notes were uploaded.',
  setup_state_corrupt: 'The local repository setup record could not be read. Your vault and remote data were kept.',
  network: 'Offline. Your changes stay on this device and will sync when the connection returns.',
  missing_attachment: 'A referenced attachment is missing. Restore its original file from a backup, then retry. Your notes were kept.',
  too_large: 'A file or snapshot exceeds the supported size. Local changes are kept. Reduce the attachment size and retry.',
  head_changed_or_branch_policy: 'GitHub changed during publication or a branch rule blocked it. Retry after checking the branch rules.',
  local_changed: 'Local edits arrived during sync. They were kept; sync will retry.',
  remote_snapshot_missing: 'The remote snapshot disappeared. Sync stopped to protect local data. Check the repository history before reconnecting.',
  recovery_required: 'A recovery journal conflicts with newer files. The files were kept. Restore the verified backup into a separate workspace.',
}
function problem(e: unknown) {
  const raw = String(e)
  const code = raw.replace(/^(GITHUB|SYNC):/, '').split(':')[0]
  if (code === 'rate_limited') return t('GitHub rate limit reached. Sync will retry after the required delay.')
  return messages[code] ? t(messages[code]) : raw
}

export function GitHubAccountDialog({ onClose, onLegacy }: { onClose: () => void; onLegacy: () => void }) {
  const [st, setSt] = useState<Status | null>(null)
  const [runtime, setRuntime] = useState<AccountStatus | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [repoName, setRepoName] = useState('noviq-data')
  const [create, setCreate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [installation, setInstallation] = useState<{ repo: string; create: boolean } | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [vaults, setVaults] = useState<RemoteVault[] | null>(null)
  const [quiet, setQuiet] = useState<number | null>(null)
  const [poll, setPoll] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const polling = useRef(false)
  const refresh = useCallback(async () => {
    const [status, state] = await Promise.all([action<Status>('status'), accountStatus()])
    setSt(status); setRuntime(state)
  }, [])
  const loadConflicts = useCallback(() => action<Conflict[]>('conflicts').then((rows) => setConflicts(rows)), [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose() }
      if (e.key === 'Tab') {
        const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]') ?? [])
        const first = focusable[0], last = focusable.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose, busy])
  useEffect(() => {
    let alive = true
    const update = () => { if (alive) void refresh().catch((e) => setError(String(e))) }
    update(); const timer = window.setInterval(update, 2500)
    void loadConflicts().catch(() => {})
    return () => { alive = false; window.clearInterval(timer); void action('cancel').catch(() => {}) }
  }, [refresh, loadConflicts])
  useEffect(() => { if (runtime?.lastAt) void loadConflicts().catch(() => {}) }, [runtime?.lastAt, loadConflicts])
  useEffect(() => {
    if (!device) return
    let cancelled = false
    let interval = device.interval
    const expires = Date.now() + device.expiresIn * 1000
    let timer = 0
    const next = async () => {
      if (cancelled) return
      if (Date.now() >= expires) { setDevice(null); setError(t('The authorization code expired. Start sign-in again.')); return }
      if (polling.current) { timer = window.setTimeout(next, interval * 1000); return }
      polling.current = true
      try {
        const result = await action<{ pending: boolean; interval?: number }>('poll')
        if (cancelled) return
        if (!result.pending) { setDevice(null); setNote(t('Signed in. Install the App for your selected data repository, then connect the workspace.')); await refresh(); return }
        interval = result.interval ?? interval
      } catch (e) { if (!cancelled) { setError(String(e)); setDevice(null) }; return }
      finally { polling.current = false }
      if (!cancelled) timer = window.setTimeout(next, interval * 1000)
    }
    timer = window.setTimeout(next, interval * 1000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [device, refresh])
  const run = async (f: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setNote('')
    try { await f(); await refresh() } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const connect = () => run(async () => {
    await durable()
    try {
      const result = await action<{ backup: string }>('connect', { repo: repoName, create })
      setNote(t('A verified backup was saved before switching providers.') + '\n' + result.backup)
      await loadConflicts()
    } catch (e) {
      if (String(e) !== 'GITHUB:installation_required') throw e
      setInstallation({ repo: repoName, create })
      // This is a normal setup step. The user confirms repository access on GitHub itself.
      await action('open', { target: 'install' })
    }
  })
  useEffect(() => {
    if (!installation) return
    let cancelled = false, checking = false
    const started = Date.now()
    const check = async () => {
      if (cancelled || checking) return
      if (Date.now() - started > 15 * 60_000) { setInstallation(null); setNote(t('Repository setup timed out. You can continue setup again.')); return }
      checking = true
      try {
        const result = await action<{ ready: boolean }>('repository-access', { repo: installation.repo })
        if (cancelled || !result.ready) return
        setBusy(true); setError('')
        await durable()
        if (cancelled) return
        const connected = await action<{ backup: string }>('connect', installation)
        if (cancelled) return
        setBusy(false); setInstallation(null)
        setNote(t('A verified backup was saved before switching providers.') + '\n' + connected.backup)
        await refresh(); await loadConflicts()
      } catch (e) {
        if (!cancelled && String(e) !== 'GITHUB:installation_required') { setBusy(false); setInstallation(null); setError(String(e)) }
      } finally { checking = false; if (!cancelled) setBusy(false) }
    }
    const timer = window.setInterval(() => void check(), 5000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [installation, refresh, loadConflicts])
  const download = (v: RemoteVault) => run(async () => {
    const parent = await chooseFolder({ directory: true, multiple: false, title: t('Choose a folder for the downloaded workspace') })
    if (typeof parent !== 'string') return
    await durable()
    await action('download', { repo: repoName, id: v.id, parent, name: v.name || 'Noviq-' + v.id.slice(0, 8) })
    window.location.reload()
  })
  const stateLabel = runtime?.state === 'syncing' ? 'Syncing…' : runtime?.state === 'offline' ? 'Offline' : runtime?.state === 'error' ? 'Sync needs attention' : runtime?.reason === 'CONFLICTS' ? 'Conflicts need review' : runtime?.syncOn ? 'Ready to sync' : 'Sync paused'
  const setupRecovery = ['GITHUB:installation_required', 'GITHUB:repository_creation_uncertain', 'GITHUB:repository_name_unavailable'].some((code) => error.includes(code))
  const quietValue = quiet ?? st?.binding?.quiet_seconds ?? 15
  const pollValue = poll ?? st?.binding?.poll_seconds ?? 120
  return <div className="overlay" onMouseDown={() => !busy && onClose()}>
    <div ref={root} className="modal wsd acct gh-dialog" role="dialog" aria-modal="true" aria-labelledby="github-title" onMouseDown={(e) => e.stopPropagation()}>
      <div className="wsd-head"><b id="github-title">{t('GitHub sync')}</b><button className="icon-btn" disabled={busy} onClick={onClose} aria-label={t('Close')}><Ic.Close size={16} /></button></div>
      <div className="wsd-body gh-body" aria-busy={busy}>
        <div className="gh-intro"><span className="gh-mark"><Ic.Cloud size={24} /></span><div><h3>{t('Your notes. Your private repository.')}</h3><p>{t('Save locally, work offline and sync your personal devices through GitHub.')}</p></div></div>
        {busy && <p className="gh-progress" role="status"><i className="acct-spin" />{t('Working… Keep this window open.')}</p>}
        {(error || runtime?.error) && <div className="acct-err" role="alert"><p>{problem(error || runtime?.error)}</p><details><summary>{t('Error details')}</summary><pre dir="ltr">{error || runtime?.error}</pre></details><div className="acct-row"><button disabled={busy} onClick={() => run(async () => setDiagnostics(await action<Record<string, unknown>>('diagnostics')))}>{t('Check GitHub connection')}</button>{setupRecovery && <><button disabled={busy} onClick={() => run(() => action('open', { target: 'install' }))}>{t('Give App access to repository')}</button><button disabled={busy} onClick={() => { setCreate(false); setError(''); setNote(t('Existing repository selected. After granting App access, use Back up and connect this workspace.')) }}>{t('Continue with existing repository')}</button></>}</div></div>}
        {diagnostics && <details className="gh-card gh-diagnostics" open><summary>{t('Connection diagnostics')}</summary><pre dir="ltr">{JSON.stringify(diagnostics, null, 2)}</pre></details>}
        {installation && <section className="gh-notice gh-installation" role="status"><h4>{t('Allow access to your data repository')}</h4><p>{t('Sign-in is complete. In GitHub, select this repository for the App. This window will continue automatically after access is confirmed.')}</p><b dir="ltr">{installation.repo}</b><div className="acct-row"><button disabled={busy} onClick={() => run(() => action('open', { target: 'install' }))}>{t('Open GitHub repository permissions')}</button><button disabled={busy} onClick={() => setInstallation(null)}>{t('Cancel setup')}</button></div><small>{t('Waiting for repository access…')}</small></section>}
        {note && <p className="gh-notice" role="status" dir="auto">{note}</p>}
        {!st ? <p role="status">{t('Loading…')}</p> : <>
          {!st.configured && <p className="gh-notice">{t(messages.app_not_configured)}</p>}
          <section className="gh-card"><h4>{t('1. GitHub account')}</h4>
            {st.signedIn ? <><div className="gh-account"><Ic.Check size={17} /><b dir="ltr">{st.login}</b><span>{t('Connected')}</span></div><div className="acct-row"><button disabled={busy || !!installation} onClick={() => run(async () => { await action('begin').then((d) => setDevice(d as Device)) })}>{t('Sign in again')}</button><button disabled={busy || !!installation} onClick={() => run(async () => { await action('disconnect'); setDevice(null) })}>{t('Disconnect this account locally')}</button></div><small>{t('Disconnect keeps your files and repository. Revoke App access in GitHub settings separately.')}</small></> : <button className="primary" disabled={busy || !st.configured || !!device} onClick={() => run(async () => setDevice(await action<Device>('begin')))}>{t('Sign in with GitHub')}</button>}
            {device && <div className="gh-device"><p>{t('Enter this code on GitHub to authorize this device:')}</p><code dir="ltr">{device.userCode}</code><div className="acct-row"><button className="primary" disabled={busy} onClick={() => run(() => action('open', { target: 'device' }))}>{t('Open GitHub authorization')}</button><button disabled={busy} onClick={() => { setDevice(null); void action('cancel').catch((e) => setError(String(e))) }}>{t('Cancel')}</button></div><small role="status">{t('Waiting for authorization…')}</small></div>}
          </section>
          <section className="gh-card"><h4>{t('2. Private data repository')}</h4>
            {st.binding ? <><div className="gh-account"><b dir="ltr">{st.binding.owner}/{st.binding.repo}</b><span className="gh-state" role="status">{t(stateLabel)}</span></div><p>{t('Only this provider is active for this workspace.')}</p><dl className="gh-facts"><dt>{t('Branch')}</dt><dd dir="ltr">{st.binding.branch}</dd><dt>{t('Last sync')}</dt><dd>{runtime?.lastAt ? new Date(runtime.lastAt).toLocaleString(locale()) : t('Not yet')}</dd><dt>{t('Migration backup')}</dt><dd dir="auto">{st.binding.backup || t('Downloaded workspace')}</dd></dl>
              <div className="acct-row"><button className="primary" disabled={busy || runtime?.state === 'syncing'} onClick={() => run(async () => { await durable(); await syncNow() })}>{t('Sync now')}</button><button disabled={busy} onClick={() => run(() => syncSet(!runtime?.syncOn))}>{runtime?.syncOn ? t('Pause sync') : t('Resume sync')}</button><button disabled={busy} onClick={() => run(() => action('detach'))}>{t('Disconnect workspace')}</button></div>
              <details><summary>{t('Sync frequency')}</summary><div className="gh-policy"><label>{t('Quiet period')}<select value={quietValue} onChange={(e) => setQuiet(Number(e.target.value))}><option value={15}>15 s</option><option value={30}>30 s</option><option value={60}>60 s</option></select></label><label>{t('Check for remote changes')}<select value={pollValue} onChange={(e) => setPoll(Number(e.target.value))}><option value={120}>2 min</option><option value={300}>5 min</option><option value={900}>15 min</option></select></label><button disabled={busy} onClick={() => run(() => action('policy', { quietSeconds: quietValue, pollSeconds: pollValue }))}>{t('Save')}</button></div></details>
            </> : <><p>{t('The App needs Contents read/write and Metadata read access to your selected repository. Repository creation also needs Repository creation write or Administration write.')}</p><button disabled={busy || !st.signedIn || !st.installationUrl} onClick={() => run(() => action('open', { target: 'install' }))}>{t('Choose repositories in GitHub')}</button>
              <label className="acct-field"><span className="acct-label">{t('Repository name')}</span><input dir="ltr" autoComplete="off" spellCheck={false} value={repoName} disabled={busy || !!installation} onChange={(e) => { setRepoName(e.target.value); setVaults(null) }} /></label>
              <div className="segmented" role="group" aria-label={t('Repository setup')}><button className={create ? 'on' : ''} disabled={busy || !!installation} onClick={() => setCreate(true)}>{t('Create private repository')}</button><button className={!create ? 'on' : ''} disabled={busy || !!installation} onClick={() => setCreate(false)}>{t('Use existing repository')}</button></div>
              <p>{t('Before switching, a complete verified backup is saved on this device. Your existing server data stays intact. Empty repositories are initialized automatically.')}</p>
              <div className="acct-row"><button className="primary" disabled={busy || !!installation || !st.signedIn || !/^[\w.-]+$/.test(repoName)} onClick={connect}>{t('Back up and connect this workspace')}</button><button disabled={busy || !st.signedIn || create} onClick={() => run(async () => setVaults(await action<RemoteVault[]>('list', { repo: repoName })))}>{t('Find my other workspaces')}</button></div>
              {vaults && <ul className="gh-vaults">{!vaults.length && <li>{t('No workspaces found in this repository.')}</li>}{vaults.map((v) => <li key={v.id}><div><b dir="auto">{v.name || v.id}</b><small><code dir="ltr">{v.id}</code></small><small>{t('{count} files', { count: v.files })}</small></div><button disabled={busy || v.connectedHere} onClick={() => download(v)}>{v.connectedHere ? t('On this device') : t('Download to a new folder')}</button></li>)}</ul>}
            </>}
          </section>
          <section className="gh-card"><div className="gh-account"><h4>{t('Conflicts')}</h4><button disabled={busy} onClick={() => run(loadConflicts)}>{t('Refresh')}</button></div><p>{t('Conflicting versions keep their full data until you choose one. Database IDs and relations stay unchanged.')}</p>
            {!conflicts.length ? <small>{t('No unresolved conflicts.')}</small> : <button className="primary" onClick={() => { openConflictReview(); onClose() }}>{t('Review {count} conflicts in workspace', { count: conflicts.length })}</button>}
          </section>
          <p className="acct-note">{t('Trash can be restored for 7 days. Permanent deletion removes the current snapshot; older Git commits and offline devices may retain earlier bytes.')}</p>
          <p className="acct-note">{t('Public forms, webhooks and background gateway jobs still need a running database gateway. Personal note sync works without the Noviq sync server.')}</p>
          <p className="acct-note">{t('Private repositories are protected by GitHub access controls; this is not end-to-end encryption. GIF animation is preserved. Oversized files remain local with an explicit sync error.')}</p>
        </>}
        <button className="gh-legacy" disabled={busy} onClick={onLegacy}>{t('Manage legacy server account…')}</button>
      </div>
    </div>
  </div>
}
