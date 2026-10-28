import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from './store'
import { t } from './i18n'
import { githubAction, saveForSync, type SyncConflict } from './syncActions'
import { compareLines, conflictVersion } from './conflictDiff'
import * as Ic from './icons'
import './styles/conflict-review.css'

export function ConflictReview({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SyncConflict[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [raw, setRaw] = useState(false)
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
  const diff = useMemo(() => compareLines(raw ? left.raw : left.text, raw ? right.raw : right.text), [left, right, raw])
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
  let localLine = 0, remoteLine = 0
  return <section className="conflict-review" aria-label={t('Resolve sync conflicts')}>
    <header className="cr-toolbar"><div><h2>{t('Resolve sync conflicts')}</h2><p>{t('Compare both versions, then choose the version to keep.')}</p></div><span className="spacer" /><button disabled={busy} onClick={() => void refresh().catch(e => setError(String(e)))}>{t('Refresh')}</button><button disabled={busy} onClick={onClose}><Ic.Close size={16} />{t('Back to workspace')}</button></header>
    {error && <div role="alert" className="cr-error">{error}</div>}
    {loading ? <p role="status">{t('Loading…')}</p> : !conflict ? <div className="cr-empty" role="status"><Ic.Check size={32} /><h3>{t('No unresolved conflicts.')}</h3><button onClick={onClose}>{t('Back to workspace')}</button></div> : <>
      <div className="cr-selector"><label>{t('Conflicting item')}<select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>{rows.map(c => <option key={c.id} value={c.id}>{c.path} · {new Date(c.createdAt).toLocaleString()}</option>)}</select></label><span>{t('{count} conflicts remaining', { count: rows.length })}</span><label className="cr-raw"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} />{t('Full data')}</label></div>
      <div className="cr-headings" dir="ltr">{(['local', 'remote'] as const).map(side => {
        const version = side === 'local' ? left : right
        const absent = conflict[side] === null
        return <div key={side} dir="auto"><b>{t(side === 'local' ? 'This device' : 'GitHub version')}</b><span dir="auto">{version.title || conflict.path}</span><button className="primary" disabled={busy || (absent && !conflict.deleted)} onClick={() => void resolve(absent ? 'delete' : side)}>{t(absent ? 'Keep deletion' : side === 'local' ? 'Keep this device version' : 'Keep GitHub version')}</button>{absent && <small>{t('This version has no file.')}</small>}{version.binary && <small>{t('Binary attachment — choose a version or inspect the original file.')}</small>}</div>
      })}</div>
      <div className="cr-diff" dir="ltr" role="region" aria-label={t('Version comparison')} tabIndex={0}>
        {diff.map((line, i) => <div className={'cr-line' + (line.changed ? ' changed' : '')} key={i}>
          <div className={line.left === null ? 'gap' : ''}><span className="cr-number" aria-hidden="true">{line.left !== null ? ++localLine : ''}</span><span dir="auto">{line.left ?? ' '}</span></div>
          <div className={line.right === null ? 'gap' : ''}><span className="cr-number" aria-hidden="true">{line.right !== null ? ++remoteLine : ''}</span><span dir="auto">{line.right ?? ' '}</span></div>
        </div>)}
      </div>
      <footer className="cr-footer">{conflict.deleted && conflict.local !== null && conflict.remote !== null && <button disabled={busy} onClick={() => void resolve('delete')}>{t('Keep deletion')}</button>}<span>{t('Highlighted lines differ. Choosing a version keeps its complete data, including formatting and attachments.')}</span><details><summary>{t('Common version')}</summary><pre dir="auto">{conflictVersion(conflict.base).raw || t('Version unavailable')}</pre></details></footer>
    </>}
  </section>
}
