import { useEffect, useRef, useState } from 'react'
import { isTauri } from '../db'
import { t } from '../i18n'
import { repo } from '../store'
import { connectionStatus, copyConnection, disableConnection, enableConnection } from './bridge'
import type { McpStatus } from './bridge'

export function McpConnectionSettings() {
  const revision = useRef<string | null>(null)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [allowWrites, setAllowWrites] = useState(false)
  const [wholeVault, setWholeVault] = useState(false)
  const [rootIds, setRootIds] = useState<string[]>([])
  const [excludedIds, setExcludedIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const pages = repo.list().slice().sort((a, b) => a.title.localeCompare(b.title))
  useEffect(() => {
    if (!isTauri) return
    let active = true
    const refresh = () => connectionStatus().then(value => { if (active) {
      if (value.connection && revision.current !== value.connection.revision) {
        revision.current = value.connection.revision
        setAllowWrites(value.connection.policy.allowWrites); setWholeVault(value.connection.policy.wholeVault); setRootIds(value.connection.policy.rootIds); setExcludedIds(value.connection.policy.excludedIds)
      }
      setStatus(value)
    } }).catch(() => { if (active) setMessage(t('Connection status is unavailable.')) })
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await run() } catch { setMessage(t('Could not complete the connection action. Check that the vault is open and try again.')) }
    finally { setBusy(false) }
  }
  if (!isTauri) return <section className="sx-card"><header className="sx-card-head"><div><h3>{t('MCP connections')}</h3><p>{t('Local agent connections are available in the desktop app.')}</p></div></header></section>
  const connected = !!status?.active
  const selected = (options: HTMLCollectionOf<HTMLOptionElement>) => Array.from(options, option => option.value)
  return <section className="sx-card">
    <header className="sx-card-head"><div><h3>{t('MCP connections')}</h3><p>{t('Allow an agent client to access selected saved documents in the open vault. Access starts off and requires Nevis to stay open.')}</p></div></header>
    <div className="sx-card-body">
      <div className="sx-row"><div className="sx-tx"><b>{t('Connection')}</b><small>{connected ? status?.ready ? t('Connected. Switching vaults or reloading the app disconnects the client.') : t('Enabled, but the app bridge is unavailable.') : t('Disconnected. No local endpoint is open.')}</small></div>
        <button className="ghost-btn" disabled={busy || !status || (!connected && (!status.ready || (!wholeVault && !rootIds.length)))} onClick={() => void action(async () => {
          if (connected) { await disableConnection(); setStatus(await connectionStatus()) }
          else setStatus(await enableConnection({ wholeVault, rootIds, excludedIds, allowWrites }))
        })}>{connected ? t('Disconnect and revoke token') : t('Enable connection')}</button></div>
      <div className="sx-row"><div className="sx-tx"><b>{t('All documents in this vault')}</b><small>{t('Otherwise, select document roots below. Exclusions always take priority.')}</small></div>
        <input type="checkbox" aria-label={t('All documents in this vault')} disabled={busy || connected} checked={wholeVault} onChange={event => setWholeVault(event.target.checked)} /></div>
      <div className="sx-row wide"><label className="sx-tx" htmlFor="mcp-roots"><b>{t('Document roots')}</b><small>{t('Selected documents and their descendants. Up to 100 roots.')}</small></label>
        <select id="mcp-roots" multiple size={6} disabled={busy || connected || wholeVault} value={rootIds} onChange={event => setRootIds(selected(event.currentTarget.selectedOptions).slice(0, 100))}>
          {pages.map(page => <option key={page.id} value={page.id}>{page.title || t('Untitled')}</option>)}
        </select></div>
      <div className="sx-row wide"><label className="sx-tx" htmlFor="mcp-exclusions"><b>{t('Excluded documents')}</b><small>{t('These documents and all their descendants stay private, including history and search results. Disconnect before changing access.')}</small></label>
        <select id="mcp-exclusions" multiple size={6} disabled={busy || connected} value={excludedIds} onChange={event => setExcludedIds(selected(event.currentTarget.selectedOptions).slice(0, 100))}>
          {pages.map(page => <option key={page.id} value={page.id}>{page.title || t('Untitled')}</option>)}
        </select></div>
      <div className="sx-row"><div className="sx-tx"><b>{t('Document editing')}</b><small>{status?.writesAvailable ? t('Enable revision-gated edits, creation and undo for this connection. Unsaved editor drafts are protected.') : t('This build does not support document editing.')}</small></div><input type="checkbox" aria-label={t('Allow document editing')} disabled={busy || connected || !status?.writesAvailable} checked={allowWrites} onChange={event => setAllowWrites(event.target.checked)} /></div>
      {connected && <div className="sx-row wide"><div className="sx-tx"><b>{t('Client setup')}</b><small>{t('Use a client that supports Streamable HTTP and a Bearer authorization header. Connection details contain a private token; share them only with your authorized client.')}</small></div>
        <code dir="ltr">{status?.endpoint}</code>
        <button className="ghost-btn" disabled={busy} onClick={() => void action(async () => { await copyConnection(status!); setMessage(t('Connection URL and authorization header copied.')) })}>{t('Copy connection details')}</button>
      </div>}
      {message && <p role="status">{message}</p>}
    </div>
  </section>
}
