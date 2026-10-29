import { driveSettingLabels, type SettingsPolicy } from './driveSettingsPolicy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { open as chooseFolder } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { saveForSync, openConflictReview, syncWorkspaceNow } from './syncActions'
import { accountStatus, vaultList, vaultOpen, freezeStorage, thawStorage, type VaultEntry, type AccountStatus } from './db'
import { createDriveWorkspace, switchWorkspaceSafely } from './workspaceCloud'
import { enableDriveBlockIds } from './editor/stableBlockIds'
import { t } from './i18n'
import * as Ic from './icons'
import { drivePreferenceGroups, driveVisualState, type DriveTab } from './drivePresentation'
import { DriveTime, DriveDialogFrame, DriveCard, DriveActions, DriveEmpty, DriveProfile, DriveWorkspaceStatus, DriveWorkspaceForm, DriveWorkspaceList, DriveDisclosure } from './DriveSyncUi'
import { repo } from './store'

const driveAction = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>('drive_action', { action, args })
interface DriveStatus {
  driveSyncEnabled: boolean; releaseReady: boolean; currentVaultId: string | null
  auth: { checking?: boolean; error?: string; developerSetup?: boolean; configured: boolean; signedIn: boolean; email?: string; subject?: string }
  binding: { vaultId: string; folderId: string; rootId: string; paused: boolean; backup: string } | null
  settingsPolicy?: SettingsPolicy
  pending: number; lastVerifiedAt: number; metrics: Record<string, unknown> | null; gc: Record<string, unknown> | null
}
interface RemoteVault { id: string; folderId: string; name: string }
interface RemoteRoot { id: string; name: string; selected: boolean; verified: boolean; vaults: number | null; error?: string }
interface HistoryPreview { checkpointId: string; createdAt: number; pages: number; attachments: number; databases: Record<string, number>; titleSample: { id: string; title: string; deleted: boolean }[]; sampleOmitted: number; fullyVerified: boolean }
interface RelationLink { id: string; from: string; to: string }
interface RelationConflict { id: string; definitionId: string; choices: RelationLink[] }
interface RelationPreview { id: string; preferred: string; digest: string; kept: RelationLink[]; archived: RelationLink[] }
interface RestorePoint { id: string; checkpointId: string; createdAt: number; files: number }
const explain = (e: unknown) => {
  const code = String(e).replace(/^DRIVE:/, '')
  const messages: Record<string, string> = {
    desktop_credentials_required: 'Enter the saved Desktop client secret or import its JSON before signing in.',
    invalid_client_secret: 'Paste only the client secret, without the client ID or extra text.',
    client_file_mismatch: 'This Desktop OAuth JSON belongs to a different client ID.',
    invalid_client_file: 'Choose the original Desktop OAuth JSON downloaded from Google Cloud.',
    oauth_client_rejected: 'Google rejected this OAuth client. Check that it is an enabled Desktop app client in the configured project.',
    oauth_scope_rejected: 'Google rejected the requested scopes. Check the project Data Access configuration.',
    oauth_request_rejected: 'Google rejected the sign-in request. Check the Desktop OAuth configuration.',
    oauth_cancelled: 'Google sign-in was cancelled. Local files and pending changes were kept.',
    oauth_not_configured: 'Google sign-in is unavailable in this build. Please install an updated version.',
    feature_disabled: 'Drive sync is disabled in this build because release checks are incomplete.',
    sign_in_required: 'Google authorization expired or was revoked. Sign in again. Pending changes are kept.',
    account_mismatch: 'This workspace belongs to another Google account. Reconnect with its original account.',
    secure_storage_unavailable: 'The operating system credential store is unavailable. No token was saved to a file.',
    remote_unavailable: 'The remote file or folder is unavailable. Local data is kept. Check access before retrying.',
    pending_outbox: 'Publish pending changes before changing the provider.',
    pending_local_edits: 'Save and sync local changes before changing the provider or creating a restore point.',
    duplicate_roots: 'Multiple Nevis roots were found. Sync stopped; no folder was chosen automatically.',
    db_relation_cardinality: 'Database links need a decision. Open Database link conflicts and preview the link to keep.',
    db_duplicate_edge: 'Duplicate database links need a decision. Open Database link conflicts.',
    conflict_changed: 'The conflict changed. Refresh it and preview your decision again.',
    root_has_other_bindings: 'Other workspaces are connected to another root. Keep their root or disconnect those workspaces first.',
    root_unavailable: 'The original Drive root is unavailable. No replacement folder was created.',
    selected_root_unavailable: 'The selected Drive root is unavailable. Restore its access or choose its original folder; no replacement root was created.',
    descriptor_missing: 'This folder is missing its Nevis identity marker and cannot be selected.',
    root_choice_corrupt: 'The saved root choice is unreadable. Local workspaces and pending changes were kept.',
    storage_full: 'Google Drive storage is full. Local changes remain on this device.',
    network: 'Google Drive is unreachable. Local saves continue independently.',
    target_exists: 'A folder with this name already exists. Choose another name or location; nothing was overwritten.',
    workspace_already_open: 'Open the current workspace or close it before creating another one.',
    vault_already_registered: 'This workspace is already on this computer. Open or locate its local folder instead.',
    existing_local_sync_state: 'Existing sync history was preserved. Locate the original local folder or restore a history copy before reconnecting.',
    download_target_missing: 'The downloaded workspace folder is missing. Locate or restore it; no empty replacement was created.',
    download_stage_missing: 'The interrupted download folder is missing. Recovery stopped to protect the cloud workspace.',
  }
  if (code.startsWith('rate_limited:')) return t('Google Drive rate limit reached. Retry will respect the required delay.')
  return t(messages[code] ?? String(e))
}
export function DriveAccountDialog({ onClose, onGitHub, onWorkspaceOpened }: { onClose: () => void; onGitHub: () => void; onWorkspaceOpened?: () => void }) {
  const clientSecretInput = useRef<HTMLInputElement>(null)
  const accountReady = useRef(false)
  const [tab, setTab] = useState<DriveTab>('overview')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null)
  const [verifiedBackup, setVerifiedBackup] = useState('')
  const [st, setSt] = useState<DriveStatus | null>(null)
  const [runtime, setRuntime] = useState<AccountStatus | null>(null)
  const [busy, setBusy] = useState(false), [waiting, setWaiting] = useState(false)
  const [error, setError] = useState(''), [note, setNote] = useState('')
  const [vaults, setVaults] = useState<RemoteVault[]>([]), [history, setHistory] = useState<RestorePoint[]>([])
  const [workspaceName, setWorkspaceName] = useState('')
  const [finding, setFinding] = useState(false), [searched, setSearched] = useState(false)
  const [localVaults, setLocalVaults] = useState<VaultEntry[]>([])
  const opened = () => onWorkspaceOpened ? onWorkspaceOpened() : window.location.reload()
  const [roots, setRoots] = useState<RemoteRoot[] | null>(null)
  const [preview, setPreview] = useState<HistoryPreview | null>(null)
  const [relationConflicts, setRelationConflicts] = useState<RelationConflict[] | null>(null)
  const [relationChoices, setRelationChoices] = useState<Record<string, string>>({})
  const [relationPreview, setRelationPreview] = useState<RelationPreview | null>(null)
  const refresh = useCallback(async () => {
    const [status, runtime, locals] = await Promise.all([driveAction<DriveStatus>('status'), accountStatus(), vaultList()])
    if (status.auth.signedIn && !status.currentVaultId && !accountReady.current) setTab('workspaces')
    accountReady.current = status.auth.signedIn
    setLocalVaults(locals.vaults)
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
  useEffect(() => {
    if (!st?.auth.signedIn || st.currentVaultId) { setFinding(false); return }
    let live = true
    setVaults([]); setSearched(false); setFinding(true)
    void driveAction<RemoteVault[]>('list').then(vaults => { if (live) { setVaults(vaults); setSearched(true) } }, e => { if (live) setError(explain(e)) }).finally(() => { if (live) setFinding(false) })
    return () => { live = false }
  }, [st?.auth.signedIn, st?.auth.subject, st?.currentVaultId])
  const run = async (f: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setNote('')
    try { await f() } catch (e) { setError(explain(e)) } finally { try { await refresh() } catch (e) { setError(previous => previous || explain(e)) }; setBusy(false) }
  }
  const close = () => { if (busy) return; if (waiting) void driveAction('cancel'); onClose() }
  useEffect(() => { if (tab !== 'advanced' && clientSecretInput.current) clientSecretInput.current.value = '' }, [tab])
  const folder = () => chooseFolder({ directory: true, multiple: false })
  const connect = () => run(async () => {
    await saveForSync()
    const result = await driveAction<{ backup: string }>('connect')
    enableDriveBlockIds(true)
    if (onWorkspaceOpened) { onWorkspaceOpened(); return }
    await repo.refreshFromStore()
    setVerifiedBackup(result.backup)
    setNote(t('Workspace connected. A local backup was created.'))
    window.dispatchEvent(new Event('data-changed'))
  })
  const switchWorkspace = (action: () => Promise<unknown>) => switchWorkspaceSafely(action, { save: saveForSync, freeze: freezeStorage, thaw: thawStorage, opened })
  const locked = busy || waiting
  const canUseDrive = !!st?.driveSyncEnabled && !!st.auth.signedIn && !st.auth.checking && !locked
  const currentName = localVaults.find(v => v.id === st?.currentVaultId)?.name || t('Current workspace')
  const visualState = driveVisualState({ connected: !!st?.binding, signedIn: !!st?.auth.signedIn, checking: st?.auth.checking, paused: !!st?.binding?.paused, state: runtime?.state, reason: runtime?.reason, error: runtime?.error, pending: st?.pending ?? 0, verified: st?.lastVerifiedAt ?? 0 })
  const signIn = () => void run(async () => { await driveAction('begin'); setWaiting(true); setTab('overview') })
  const loginDisabled = locked || !!st?.auth.checking || !st?.auth.configured || !st.driveSyncEnabled
  const findWorkspaces = () => void run(async () => { setVaults(await driveAction<RemoteVault[]>('list')); setSearched(true) })
  const createWorkspace = () => void run(async () => {
    const created = await createDriveWorkspace(workspaceName.trim() || t('My notes'), async () => {
      const parent = await chooseFolder({ directory: true, multiple: false, title: t('Choose where to keep this workspace on this computer') })
      return typeof parent === 'string' ? parent : null
    }, invoke)
    if (created) opened()
  })
  const openRemote = (id: string) => void run(async () => {
    const vault = vaults.find(v => v.id === id)
    if (!vault) return
    if (localVaults.some(local => local.id === id && local.status === 'ok')) { await switchWorkspace(() => vaultOpen(id)); return }
    const parent = await folder()
    if (typeof parent === 'string') await switchWorkspace(() => driveAction('download', { ...vault, parent }))
  })
  const loadHistory = async () => { setHistory(await driveAction<RestorePoint[]>('history')); setHistoryLoaded(true) }
  const diagnostic = (action: string) => void run(async () => setDiagnosticResult(JSON.stringify(await driveAction(action), null, 2)))
  const connectPrompt = <DriveEmpty icon={<Ic.Layers size={23} />} title={t('Connect a workspace first')} description={t('Choose a workspace to use sync preferences and restore points.')}><button type="button" className="primary" onClick={() => setTab(st?.currentVaultId ? 'overview' : 'workspaces')}>{t('Choose a workspace')}</button></DriveEmpty>
  const accountPrompt = <DriveEmpty title={st?.auth.checking ? t('Checking secure account storage…') : t('Your notes, on every device.')} description={t('Sign in to create a workspace or bring your existing notes to this computer.')}>
    {st?.auth.checking ? <span className="drive-loading"><i className="acct-spin" />{t('One moment…')}</span> : <button type="button" className="primary" disabled={loginDisabled} onClick={signIn}>{t('Sign in with Google')}</button>}
  </DriveEmpty>
  const relationSection = st?.binding && <DriveDisclosure title={t('Database link conflicts')} icon={<Ic.Link size={16} />} open={/db_relation_cardinality|db_duplicate_edge/.test(runtime?.error ?? '') || undefined}>
    <p className="drive-small">{t('Concurrent links can exceed a relation limit. Preview a decision before applying it; other candidates stay in history.')}</p>
    <DriveActions><button type="button" disabled={!canUseDrive} onClick={() => void run(async () => { setRelationConflicts(await driveAction<RelationConflict[]>('database-conflicts')); setRelationPreview(null) })}>{t('Review database links')}</button></DriveActions>
    {relationConflicts?.length === 0 && <p className="drive-small">{t('No database link conflicts remain.')}</p>}
    {relationConflicts?.map(conflict => {
      const preferred = relationChoices[conflict.id] ?? conflict.choices[0]?.id
      const plan = relationPreview?.id === conflict.id && relationPreview.preferred === preferred ? relationPreview : null
      return <div className="drive-history-preview" key={conflict.id}>
        <label className="acct-field"><span className="acct-label">{t('Preferred link')}</span><select disabled={!canUseDrive} value={preferred} onChange={event => { setRelationChoices(old => ({ ...old, [conflict.id]: event.target.value })); setRelationPreview(null) }}>{conflict.choices.map(edge => <option key={edge.id} value={edge.id}>{edge.from} → {edge.to} · {edge.id.slice(0, 8)}</option>)}</select></label>
        <DriveActions><button type="button" disabled={!canUseDrive || !preferred} onClick={() => void run(async () => setRelationPreview(await driveAction<RelationPreview>('database-conflict-preview', { id: conflict.id, preferred })))}>{t('Preview link decision')}</button></DriveActions>
        {plan && <><p className="drive-small">{t('{count} compatible links will remain active.', { count: plan.kept.length })}</p><ul>{plan.kept.slice(0, 20).map(edge => <li key={edge.id}>{edge.from} → {edge.to}</li>)}</ul><p className="drive-small">{t('{count} other candidates will be preserved in history.', { count: plan.archived.length })}</p><DriveActions><button type="button" className="primary" disabled={!canUseDrive} onClick={() => void run(async () => {
          await saveForSync()
          const result = await driveAction<{ applied: boolean; remaining: number }>('database-conflict-resolve', { id: conflict.id, preferred, digest: plan.digest })
          if (result.applied) { await repo.refreshFromStore(); window.dispatchEvent(new Event('data-changed')) }
          setRelationConflicts(await driveAction<RelationConflict[]>('database-conflicts')); setRelationPreview(null)
          setNote(t(result.applied ? 'The decision was applied locally. Cloud publication is pending.' : 'The decision was saved. Review the remaining link conflicts before applying.'))
        })}>{t('Apply this link decision')}</button></DriveActions></>}
      </div>
    })}
  </DriveDisclosure>
  const overview = !st ? <p className="drive-loading" role="status"><i className="acct-spin" />{t('Loading…')}</p> : <>
    <DriveProfile email={st.auth.email} signedIn={st.auth.signedIn} checking={st.auth.checking} />
    {waiting ? <DriveCard title={t('Continue in your browser')} icon={<Ic.Cloud size={17} />}><p className="drive-loading" role="status"><i className="acct-spin" />{t('Return here after completing Google sign-in.')}</p><DriveActions><button type="button" disabled={busy} onClick={() => void run(async () => { await driveAction('cancel'); setWaiting(false) })}>{t('Cancel')}</button></DriveActions></DriveCard> : !st.auth.signedIn && accountPrompt}
    {st.auth.signedIn && (st.currentVaultId ? <DriveWorkspaceStatus name={currentName} state={visualState} verifiedAt={st.lastVerifiedAt} pending={st.pending}>
      {runtime?.error && <p className="acct-err" role="alert">{explain(runtime.error)}</p>}
      <DriveActions>
        {st.binding ? <><button type="button" className="primary" disabled={!canUseDrive || runtime?.state === 'syncing' || st.binding.paused} onClick={() => void run(syncWorkspaceNow)}><Ic.Reset size={15} />{t('Sync now')}</button><button type="button" disabled={!canUseDrive} onClick={() => void run(() => driveAction('pause', { paused: !st.binding?.paused }))}>{t(st.binding.paused ? 'Resume sync' : 'Pause sync')}</button>{visualState === 'conflicts' && <button type="button" disabled={locked} onClick={() => { close(); openConflictReview() }}>{t('Review conflicts')}</button>}</> : <button type="button" className="primary" disabled={!canUseDrive} onClick={() => void connect()}><Ic.Cloud size={15} />{t('Back up and connect this workspace to Drive')}</button>}
        {onWorkspaceOpened && <button type="button" disabled={locked} onClick={opened}><Ic.Open size={15} />{t('Open workspace')}</button>}
      </DriveActions>
    </DriveWorkspaceStatus> : <DriveEmpty icon={<Ic.Layers size={23} />} title={t('Choose your workspace')} description={t('Create a new workspace or download one you already use.')}><button type="button" className="primary" onClick={() => setTab('workspaces')}><Ic.Plus size={15} />{t('View workspaces')}</button></DriveEmpty>)}
    {visualState === 'conflicts' && relationSection}
    <p className="drive-small drive-privacy"><Ic.Key size={14} />{t('Files stay on this computer and in your personal Google Drive. Sync is not end-to-end encrypted.')}</p>
  </>
  const workspaces = st && <>
    {!st.auth.signedIn && <p className="acct-note">{t('Sign in with Google to create or download a workspace.')}</p>}
    {!st.currentVaultId && <DriveWorkspaceForm name={workspaceName} onName={setWorkspaceName} onCreate={createWorkspace} disabled={!canUseDrive} busy={busy} />}
    {st.currentVaultId && <DriveCard title={t('On this computer')} icon={<Ic.Folder size={17} />}><div className="drive-workspace-heading"><b dir="auto">{currentName}</b><span className="acct-pill">{t(st.binding ? 'Connected to Drive' : 'Local only')}</span></div><DriveActions>{onWorkspaceOpened && <button type="button" className="primary" disabled={locked} onClick={opened}>{t('Open workspace')}</button>}<button type="button" onClick={() => setTab('overview')}>{t(st.binding ? 'Manage sync' : 'Connect to Drive')}</button></DriveActions></DriveCard>}
    <DriveWorkspaceList items={st.auth.signedIn ? vaults.map(v => ({ id: v.id, name: v.name, local: localVaults.some(local => local.id === v.id && local.status === 'ok') })) : []} loading={finding} searched={searched} disabled={!canUseDrive} onRefresh={findWorkspaces} onOpen={openRemote} />
  </>
  const preferences = st?.binding && st.auth.signedIn ? <>
    <p className="drive-description">{t('Choose which preferences follow you across devices. Your local choices stay on this computer.')}</p>
    {drivePreferenceGroups.map(group => <DriveCard title={t(group.title)} key={group.title}>{group.keys.map(key => <div className="sx-row drive-scope-row" key={key}><div className="sx-tx"><label htmlFor={`drive-scope-${key}`}>{t(driveSettingLabels[key])}</label></div><div className="sx-ctl"><select id={`drive-scope-${key}`} aria-label={`${t('Sync scope')}: ${t(driveSettingLabels[key])}`} value={st.settingsPolicy?.[key] ?? 'global'} disabled={!canUseDrive} onChange={event => { const scope = event.target.value; void run(async () => { await saveForSync(); await driveAction('settings-policy', { key, scope }) }) }}><option value="global">{t('All devices')}</option><option value="device-local">{t('This device only')}</option></select></div></div>)}</DriveCard>)}
    <p className="drive-small">{t('Previously uploaded history is retained when a preference becomes local.')}</p>
  </> : connectPrompt
  const historyPanel = st?.binding && st.auth.signedIn ? <>
    <DriveCard title={t('Restore points')} icon={<Ic.History size={17} />}>
      <p className="drive-description">{t('Keep a restore point before a major change. Restoring always creates a separate local copy.')}</p>
      <DriveActions><button type="button" className="primary" disabled={!canUseDrive} onClick={() => void run(async () => { await driveAction('checkpoint'); await loadHistory(); setNote(t('Restore point created.')) })}><Ic.Save size={15} />{t('Create restore point')}</button><button type="button" disabled={!canUseDrive} onClick={() => void run(loadHistory)}><Ic.Reset size={15} />{t(historyLoaded ? 'Refresh' : 'Load restore points')}</button></DriveActions>
    </DriveCard>
    {history.length ? <DriveCard title={t('Saved restore points')}>{history.map(point => <div className="drive-history-row" key={point.id}><div><b><DriveTime value={point.createdAt} /></b><small>{t('{count} files', { count: point.files })}</small></div><DriveActions><button type="button" disabled={!canUseDrive} onClick={() => void run(async () => setPreview(await driveAction<HistoryPreview>('history-preview', { checkpointId: point.id })))}>{t('Preview')}</button><button type="button" disabled={!canUseDrive} onClick={() => void run(async () => { const parent = await folder(); if (typeof parent === 'string') await switchWorkspace(() => driveAction('restore-copy', { checkpointId: point.id, parent })) })}><Ic.Download size={15} />{t('Restore a copy')}</button></DriveActions></div>)}</DriveCard> : <DriveEmpty icon={<Ic.History size={23} />} title={t(historyLoaded ? 'No restore points yet' : 'Your history, kept safely')} description={t('Load your saved restore points or create one for this workspace.')} />}
    {preview && <DriveCard title={t('Restore point preview')} icon={<Ic.Page size={17} />} aside={<button type="button" className="icon-btn" aria-label={t('Close preview')} onClick={() => setPreview(null)}><Ic.Close size={15} /></button>}><div className="drive-history-preview"><p className="drive-description">{t('{count} pages', { count: preview.pages })} · {t('{count} attachments', { count: preview.attachments })}</p><p className="drive-small">{t('This is a metadata preview. Restoring verifies all files and creates a separate local copy.')}</p><ul>{preview.titleSample.map(page => <li key={page.id}>{page.title || t('Untitled')}{page.deleted ? ` · ${t('Deleted')}` : ''}</li>)}</ul>{preview.sampleOmitted > 0 && <p className="drive-small">{t('{count} more pages are not listed in this preview.', { count: preview.sampleOmitted })}</p>}</div></DriveCard>}
  </> : connectPrompt
  const advanced = <>
    {st?.auth.signedIn && <DriveDisclosure title={t('Drive folder')} icon={<Ic.Folder size={16} />}>
      <p className="drive-small">{t('Choose a verified Nevis folder when more than one exists. This choice never moves connected workspaces or deletes folders.')}</p>
      <DriveActions><button type="button" disabled={!canUseDrive} onClick={() => void run(async () => setRoots(await driveAction<RemoteRoot[]>('roots')))}><Ic.Search size={15} />{t('Find Nevis root folders')}</button></DriveActions>
      {roots?.length === 0 && <p className="drive-small">{t('No existing Nevis root found. Connecting a workspace will create one.')}</p>}
      {roots?.map(folder => <div className="wsd-row" key={folder.id}><span className="wsd-ic"><Ic.Folder size={17} /></span><span className="wsd-tx"><b dir="auto">{folder.name}</b><small dir="ltr" title={folder.id}>{folder.id}</small>{folder.vaults !== null && <small>{t('{count} workspaces', { count: folder.vaults })}</small>}</span>{folder.selected && <span className="acct-pill idle">{t('Selected')}</span>}<DriveActions><button type="button" disabled={!canUseDrive} onClick={() => void run(() => driveAction('view-root', { id: folder.id }))}>{t('View folder')}</button><button type="button" disabled={!canUseDrive || !folder.verified || (Boolean(st.binding) && st.binding?.rootId !== folder.id)} onClick={() => void run(async () => { await driveAction('select-root', { id: folder.id }); setRoots(await driveAction<RemoteRoot[]>('roots')); setVaults([]); setSearched(false); setNote(t('Root selected. Existing workspace bindings were preserved.')) })}>{t('Use this folder')}</button></DriveActions>{!folder.verified && <p className="acct-err">{explain(folder.error ?? 'DRIVE:identity_mismatch')}</p>}</div>)}
    </DriveDisclosure>}
    {relationSection}
    <DriveDisclosure title={t('Sync diagnostics')} icon={<Ic.Code size={16} />}>
      <p className="drive-small">{t('Technical details for troubleshooting. Cleanup checks never delete files.')}</p>
      {st?.binding && <DriveActions><button type="button" disabled={!canUseDrive} onClick={() => diagnostic('deep-check')}>{t('Verify all local file bytes')}</button><button type="button" disabled={!canUseDrive} onClick={() => diagnostic('gc-dry-run')}>{t('Check cleanup safety (no deletion)')}</button><button type="button" disabled={!canUseDrive} onClick={() => diagnostic('gc-verify')}>{t('Verify cleanup assessment')}</button></DriveActions>}
      <pre className="drive-technical" dir="ltr">{JSON.stringify({ workspace: st?.currentVaultId, pending: st?.pending, metrics: st?.metrics, gc: st?.gc, releaseReady: st?.releaseReady }, null, 2)}</pre>
      {diagnosticResult && <pre className="drive-technical" dir="ltr">{diagnosticResult}</pre>}
      {(st?.binding?.backup || verifiedBackup) && <><p className="drive-small">{t('Verified backup')}</p><code className="drive-technical" dir="ltr">{st?.binding?.backup || verifiedBackup}</code></>}
    </DriveDisclosure>
    {st?.auth.developerSetup && <DriveDisclosure title={t('Developer configuration')} icon={<Ic.Code size={16} />}>
      <p className="drive-small">{t('Use the Desktop client secret you already saved. Google no longer offers downloads of existing secrets. This value is saved only in the operating system credential store.')}</p>
      <label className="acct-field"><span className="acct-label">{t('Desktop client secret')}</span><input ref={clientSecretInput} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1024} disabled={locked || !st.auth.configured} dir="ltr" /></label>
      <DriveActions><button type="button" disabled={locked || !st.auth.configured || !st.driveSyncEnabled} onClick={() => void run(async () => { const secret = clientSecretInput.current?.value ?? ''; if (clientSecretInput.current) clientSecretInput.current.value = ''; await driveAction('configure-client', { secret }); setNote(t('Desktop OAuth credentials saved in the operating system credential store. Sign in again.')) })}>{t('Save client secret securely')}</button><button type="button" disabled={locked || !st.driveSyncEnabled} onClick={() => void run(async () => { const path = await chooseFolder({ multiple: false, directory: false, filters: [{ name: 'Google Desktop OAuth', extensions: ['json'] }] }); if (typeof path === 'string') { await driveAction('import-client', { path }); setNote(t('Desktop OAuth credentials saved in the operating system credential store. Sign in again.')) } })}>{t('Import Desktop OAuth JSON')}</button></DriveActions>
    </DriveDisclosure>}
    {st?.auth.signedIn && <DriveCard title={t('Account')} icon={<Ic.Key size={17} />}>
      <div className="acct-line"><span>{t('Reconnect Google')}</span><DriveActions><button type="button" disabled={loginDisabled} onClick={signIn}>{t('Reconnect')}</button></DriveActions></div>
      {st.binding && <div className="acct-line"><span>{t('Keep this workspace local')}</span><DriveActions><button type="button" disabled={locked || st.pending > 0} title={t('Finish syncing before switching to local only.')} onClick={() => void run(async () => { await saveForSync(); await driveAction('detach') })}>{t('Use local only')}</button></DriveActions></div>}
      <div className="acct-line danger"><span>{t('Local files stay on this computer.')}</span><DriveActions><button type="button" className="danger" disabled={locked} onClick={() => void run(() => driveAction('disconnect'))}>{t('Sign out')}</button></DriveActions></div>
    </DriveCard>}
  </>
  return <DriveDialogFrame tab={tab} onTab={setTab} panels={{ overview, workspaces, history: historyPanel, preferences, advanced }} busy={busy} error={error || (st?.auth.error ? explain(st.auth.error) : '') || (st && !st.driveSyncEnabled ? t('Drive sync is disabled in this build because release checks are incomplete.') : '') || (st && !st.auth.configured ? t('Google sign-in is unavailable in this build. Please install an updated version.') : '')} note={note} onClose={close} onOtherProviders={() => { if (waiting) void driveAction('cancel'); onGitHub() }} onLocal={!st?.currentVaultId ? close : undefined} />
}
