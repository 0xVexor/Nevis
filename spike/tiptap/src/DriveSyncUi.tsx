import { useEffect, useLayoutEffect, useId, useRef, type ReactNode } from 'react'
import * as Ic from './icons'
import { t, locale } from './i18n'
import { driveStateLabels, driveTimestamp, type DriveTab, type DriveVisualState } from './drivePresentation'
import './styles/drive-sync.css'

const tabs: { id: DriveTab; label: string; icon: typeof Ic.Cloud }[] = [
  { id: 'overview', label: 'Overview', icon: Ic.Cloud },
  { id: 'workspaces', label: 'Workspaces', icon: Ic.Layers },
  { id: 'history', label: 'History', icon: Ic.History },
  { id: 'preferences', label: 'Preferences', icon: Ic.Settings },
  { id: 'advanced', label: 'Advanced', icon: Ic.Code },
]
export function DriveDialogFrame({ tab, onTab, panels, onClose, onOtherProviders, onLocal, busy, error, note }: {
  tab: DriveTab; onTab: (tab: DriveTab) => void; panels: Record<DriveTab, ReactNode>; onClose: () => void; onOtherProviders: () => void; onLocal?: () => void; busy: boolean; error?: string; note?: string
}) {
  const root = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0 }, [tab])
  const close = useRef(onClose), working = useRef(busy)
  const prefix = useId()
  useLayoutEffect(() => { close.current = onClose; working.current = busy }, [onClose, busy])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!working.current) close.current() }
      if (event.key !== 'Tab') return
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),summary,select:not(:disabled),input:not(:disabled),a[href]') ?? [])].filter(node => node.getClientRects().length > 0)
      const first = nodes[0], last = nodes.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={root} className="modal wsd acct drive-dialog" role="dialog" aria-modal="true" aria-labelledby={`${prefix}-title`}>
      <header className="wsd-head drive-head">
        <span className="sx-ic"><Ic.Cloud size={19} /></span>
        <div className="drive-heading"><h2 id={`${prefix}-title`}>{t('Account and sync')}</h2><p>Google Drive</p></div>
        <span className="drive-preview" title={t('Experimental — not ready for real vaults until release checks pass.')}>{t('Preview build')}</span>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label={t('Close')}><Ic.Close size={17} /></button>
      </header>
      <nav className="set-tabs drive-tabs" role="tablist" aria-label={t('Account sections')}>
        {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`${prefix}-${id}-tab`} aria-controls={`${prefix}-${id}-panel`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'on' : ''} onClick={() => onTab(id)} onKeyDown={event => {
          const rtl = document.documentElement.dir === 'rtl'
          const step = event.key === 'ArrowDown' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 1 : event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1 : 0
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : step ? (index + step + tabs.length) % tabs.length : -1
          if (next < 0) return
          event.preventDefault(); event.stopPropagation(); onTab(tabs[next].id); document.getElementById(`${prefix}-${tabs[next].id}-tab`)?.focus()
        }}><Icon size={16} /><span>{t(label)}</span></button>)}
      </nav>
      <div ref={content} className="drive-content" aria-busy={busy}>
        {error && <p className="acct-err" role="alert">{error}</p>}
        {note && <p className="acct-note" role="status">{note}</p>}
        {tabs.map(({ id }) => <div key={id} id={`${prefix}-${id}-panel`} className="drive-pane" role="tabpanel" aria-labelledby={`${prefix}-${id}-tab`} hidden={id !== tab}>{panels[id]}</div>)}
      </div>
      <footer className="drive-footer">
        <span className="drive-footer-note" role="status">{busy ? <><i className="acct-spin" />{t('Working…')}</> : t('Preview — use test workspaces.')}</span>
        <div className="drive-footer-actions">
          {onLocal && <button type="button" className="acct-link" onClick={onLocal} disabled={busy}><Ic.Folder size={14} />{t('Local workspaces')}</button>}
          <button type="button" className="acct-link" onClick={onOtherProviders} disabled={busy}>{t('Other sync providers')}</button>
        </div>
      </footer>
    </section>
  </div>
}
export function DriveCard({ title, icon, aside, children }: { title: string; icon?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <section className="acct-card drive-card"><header>{icon && <span className="drive-card-icon">{icon}</span>}<h3>{title}</h3>{aside}</header>{children}</section>
}
export function DriveActions({ children }: { children: ReactNode }) { return <div className="wsd-acts drive-actions">{children}</div> }
export function DriveEmpty({ title, description, children, icon = <Ic.Cloud size={23} /> }: { title: string; description?: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="drive-empty"><span className="acct-hero-ic">{icon}</span><h3>{title}</h3>{description && <p>{description}</p>}{children && <DriveActions>{children}</DriveActions>}</div>
}
export function DriveProfile({ email, checking, signedIn }: { email?: string; checking?: boolean; signedIn: boolean }) {
  return <div className="acct-profile drive-profile"><span className="acct-avatar">{checking ? <i className="acct-spin" /> : email?.slice(0, 1).toUpperCase() || <Ic.Cloud size={21} />}</span><div><small>{checking ? t('Checking secure account storage…') : signedIn ? t('Signed in with Google') : t('Personal Google Drive')}</small><b dir={email ? 'ltr' : undefined}>{email || (checking ? t('One moment…') : t('Not connected'))}</b></div>{signedIn && <span className="acct-pill idle"><i />{t('Signed in')}</span>}</div>
}
export function DriveTime({ value }: { value: number }) {
  const date = driveTimestamp(value)
  return date ? <time dateTime={date.toISOString()}>{date.toLocaleString(locale())}</time> : <>{t('Not yet')}</>
}
export function DriveWorkspaceStatus({ name, state, verifiedAt, pending, children }: { name: string; state: DriveVisualState; verifiedAt: number; pending: number; children?: ReactNode }) {
  const tone = state === 'error' || state === 'conflicts' ? 'error' : ['paused', 'offline', 'signed-out', 'pending'].includes(state) ? 'paused' : state === 'syncing' ? 'syncing' : state === 'idle' ? 'idle' : ''
  return <DriveCard title={t('Current workspace')} icon={<Ic.Layers size={17} />}>
    <div className="drive-workspace-heading"><b dir="auto">{name}</b><span className={`acct-pill ${tone}`} role="status"><i />{t(driveStateLabels[state])}</span></div>
    <dl className="wsd-info drive-sync-facts"><dt>{t('Last verified')}</dt><dd>{<DriveTime value={verifiedAt} />}</dd><dt>{t('Pending uploads')}</dt><dd>{pending.toLocaleString(locale())}</dd></dl>
    {children}
  </DriveCard>
}
export function DriveWorkspaceForm({ name, onName, onCreate, disabled, busy }: { name: string; onName: (name: string) => void; onCreate: () => void; disabled: boolean; busy: boolean }) {
  return <DriveCard title={t('Create a workspace in Google Drive')} icon={<Ic.Plus size={17} />}>
    <p className="drive-description">{t('Your workspace stays available offline on this computer and syncs with Google Drive.')}</p>
    <form className="acct-form" onSubmit={event => { event.preventDefault(); if (!disabled) onCreate() }}>
      <label className="acct-field"><span className="acct-label">{t('Workspace name')}</span><input dir="auto" maxLength={120} value={name} onChange={event => onName(event.target.value)} placeholder={t('My notes')} disabled={busy} /></label>
      <DriveActions><button type="submit" className="primary" disabled={disabled}><Ic.Plus size={15} />{busy ? t('Working…') : t('Create and open workspace')}</button></DriveActions>
    </form>
  </DriveCard>
}
export function DriveWorkspaceList({ items, loading, searched, disabled, onRefresh, onOpen }: { items: { id: string; name: string; local: boolean }[]; loading: boolean; searched: boolean; disabled: boolean; onRefresh: () => void; onOpen: (id: string) => void }) {
  return <DriveCard title={t('Your workspaces in Google Drive')} icon={<Ic.Cloud size={17} />} aside={<button type="button" className="icon-btn" onClick={onRefresh} disabled={disabled || loading} aria-label={t('Find my Drive workspaces')} title={t('Refresh')}><Ic.Reset size={16} /></button>}>
    {loading ? <p className="drive-loading" role="status"><i className="acct-spin" />{t('Finding your workspaces…')}</p> : items.length ? <div className="wsd-list">{items.map(item => <div key={item.id} className="wsd-row"><span className="wsd-ic"><Ic.Layers size={17} /></span><span className="wsd-tx"><b dir="auto">{item.name}</b><small>{item.local ? t('On this computer') : t('Available to download')}</small></span><DriveActions><button type="button" disabled={disabled} onClick={() => onOpen(item.id)}>{item.local ? <Ic.Open size={15} /> : <Ic.Download size={15} />}{t(item.local ? 'Open workspace' : 'Download and open workspace')}</button></DriveActions></div>)}</div> : <div className="drive-list-empty"><Ic.Folder size={24} /><p>{t(searched ? 'No workspaces found in Google Drive. Create your first workspace above.' : 'Find your existing workspaces to bring them to this computer.')}</p>{!searched && <DriveActions><button type="button" disabled={disabled} onClick={onRefresh}>{t('Find my Drive workspaces')}</button></DriveActions>}</div>}
  </DriveCard>
}
export function DriveDisclosure({ title, icon, open, children }: { title: string; icon?: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className="drive-disclosure" open={open}><summary>{icon}{title}<span className="drive-chevron"><Ic.Chevron size={15} /></span></summary><div className="drive-disclosure-body">{children}</div></details>
}
