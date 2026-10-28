import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from './store'
import { t } from './i18n'
import { githubAction, saveForSync, type SyncConflict } from './syncActions'
import { compareLines, conflictVersion } from './conflictDiff'
import { ConflictDocument } from './ConflictDocument'
import * as Ic from './icons'
import './styles/conflict-review.css'

export function ConflictReview({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SyncConflict[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const next = await githubAction<SyncConflict[]>('conflicts')
    if (!alive.current) return
    setRows(next); setSelected(id => next.some(c => c.id === id) ? id : next[0]?.id ?? '')
    setLoading(false)
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh().catch(e => { setError(String(e)); setLoading(false) })
    const timer = window.setInterval(() => void refresh().catch(e => setError(String(e))), 5000)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [refresh])
  const conflict = rows.find(c => c.id === selected)
  const left = useMemo(() => conflictVersion(conflict?.local ?? null), [conflict?.local])
  const right = useMemo(() => conflictVersion(conflict?.remote ?? null), [conflict?.remote])
  const changes = useMemo(() => {
    const blocks = (raw: string) => { try { const v = JSON.parse(raw); return (v.type === 'doc' ? v.content : v.content?.content)?.map((b: unknown) => JSON.stringify(b)).join('\n') ?? '' } catch { return '' } }
    const aligned = compareLines(blocks(left.raw), blocks(right.raw))
    const local: number[] = [], remote: number[] = []
    let l = 0, r = 0
    for (const row of aligned) { if (row.left !== null) { if (row.changed) local.push(l); l++ }; if (row.right !== null) { if (row.changed) remote.push(r); r++ } }
    return { local, remote }
  }, [left.raw, right.raw])
  const resolve = async (choice: string) => {
    if (!conflict || busy) return
    setBusy(true); setError('')
    try {
      await saveForSync()
      await githubAction('resolve', { id: conflict.id, choice })
      await repo.refreshFromStore(); window.dispatchEvent(new Event('data-changed'))
      await refresh()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <section className="conflict-review" aria-label={t('Resolve sync conflicts')}>
    <header className="cr-toolbar"><span className="cr-feature-icon"><Ic.Columns size={23} /></span><div><h2>{t('Resolve sync conflicts')}</h2><p>{t('Compare both versions, then choose the version to keep.')}</p></div><span className="spacer" /><button disabled={busy} onClick={() => void refresh().catch(e => setError(String(e)))}>{t('Refresh')}</button><button disabled={busy} onClick={onClose}><Ic.Close size={16} />{t('Back to workspace')}</button></header>
    {error && <div role="alert" className="cr-error">{error}</div>}
    {loading ? <p role="status">{t('Loading…')}</p> : !conflict ? <div className="cr-empty" role="status"><Ic.Check size={32} /><h3>{t('No unresolved conflicts.')}</h3><button onClick={onClose}>{t('Back to workspace')}</button></div> : <>
      <div className="cr-selector"><label>{t('Conflicting item')}<select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>{rows.map(c => <option key={c.id} value={c.id}>{c.path} · {new Date(c.createdAt).toLocaleString()}</option>)}</select></label><span>{t('{count} conflicts remaining', { count: rows.length })}</span></div>
      <div className="cr-panes" dir="ltr" role="region" aria-label={t('Version comparison')}>
        {(['local', 'remote'] as const).map(side => {
          const absent = conflict[side] === null
          return <section className="cr-pane" key={side} dir="auto" aria-label={t(side === 'local' ? 'This device' : 'GitHub version')}>
            <header className="cr-pane-head"><span className="cr-side-label">{side === 'local' ? <Ic.Page size={16} /> : <Ic.Cloud size={16} />}<b>{t(side === 'local' ? 'This device' : 'GitHub version')}</b></span><button className="primary" disabled={busy || (absent && !conflict.deleted)} onClick={() => void resolve(absent ? 'delete' : side)}><Ic.Check size={15} />{t(absent ? 'Keep deletion' : side === 'local' ? 'Keep this device version' : 'Keep GitHub version')}</button></header>
            <div className="cr-pane-scroll" tabIndex={0}><ConflictDocument encoded={conflict[side]} changed={changes[side]} /></div>
          </section>
        })}
      </div>
      <footer className="cr-footer">{conflict.deleted && conflict.local !== null && conflict.remote !== null && <button disabled={busy} onClick={() => void resolve('delete')}>{t('Keep deletion')}</button>}<span>{t('Highlighted blocks differ. Choose the complete version you want to keep.')}</span><details><summary>{t('Common version')}</summary><ConflictDocument encoded={conflict.base} /></details><details><summary>{t('Technical details')}</summary><div className="cr-technical">{(['local', 'remote'] as const).map(side => <div key={side}><b>{t(side === 'local' ? 'This device' : 'GitHub version')}</b><pre dir="ltr">{conflictVersion(conflict[side]).raw || t('Version unavailable')}</pre></div>)}</div></details></footer>
    </>}
  </section>
}
