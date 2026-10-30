import { useEffect, useRef, useState } from 'react'
import { isTauri } from '../db'
import { t } from '../i18n'
import * as Ic from '../icons'
import { repo } from '../store'
import { connectionStatus, copyConnection, copyForAnyAi, disableConnection, enableConnection, installClient } from './bridge'
import type { AiClient } from './bridge'
import type { McpStatus } from './bridge'

const clients: { id: AiClient; label: string }[] = [{ id: 'claude', label: 'Claude Desktop' }, { id: 'codex', label: 'ChatGPT / Codex' }, { id: 'gemini', label: 'Gemini CLI' }]

const Switch = ({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) => (
  <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />
)

/** One switch turns the connection on for the whole vault; hiding single documents lives under "Advanced". */
export function McpConnectionSettings() {
  const revision = useRef<string | null>(null)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [allowWrites, setAllowWrites] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const pages = repo.list().slice().sort((a, b) => a.title.localeCompare(b.title))
  useEffect(() => {
    if (!isTauri) return
    let active = true
    const refresh = () => connectionStatus().then(value => { if (active) {
      if (value.connection && revision.current !== value.connection.revision) {
        revision.current = value.connection.revision
        setAllowWrites(value.connection.policy.allowWrites); setHiddenIds(value.connection.policy.excludedIds)
      }
      setStatus(value)
    } }).catch(() => { if (active) setMessage(t('Connection status is unavailable.')) })
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await run() } catch (e) { setMessage(t('Could not complete the connection action. Check that the vault is open and try again.') + ' (' + (e instanceof Error ? e.message : String(e)).slice(0, 120) + ')') }
    finally { setBusy(false) }
  }
  const head = <header className="sx-card-head"><span className="sx-ic"><Ic.Globe /></span><div><h3>{t('AI connection')}</h3><p>{t('Let an AI app read, and optionally edit, the documents in this vault. It works only while Nevis is open.')}</p></div></header>
  if (!isTauri) return <section className="sx-card">{head}<div className="sx-card-body"><p className="sx-note">{t('Local agent connections are available in the desktop app.')}</p></div></section>
  const connected = !!status?.active
  const locked = busy || connected
  const toggle = (on: boolean) => void action(async () => {
    if (on) setStatus(await enableConnection({ wholeVault: true, rootIds: [], excludedIds: hiddenIds, allowWrites }))
    else { await disableConnection(); setStatus(await connectionStatus()) }
  })
  const setHidden = (id: string, hidden: boolean) => setHiddenIds(ids => hidden ? [...ids, id] : ids.filter(x => x !== id))
  return <section className="sx-card">
    {head}
    <div className="sx-card-body">
      <div className="sx-row"><div className="sx-tx"><b>{t('Allow AI access')}</b><small>{connected ? status?.ready ? t('Connected. Switching vaults or reloading the app disconnects the client.') : t('Enabled, but the app bridge is unavailable.') : t('Off. Nothing can reach your documents.')}</small></div>
        <Switch label={t('Allow AI access')} on={connected} disabled={busy || !status || (!connected && !status.ready)} onChange={toggle} /></div>
      <div className="sx-row"><div className="sx-tx"><b>{t('Allow document editing')}</b><small>{status?.writesAvailable ? connected ? t('Turn the connection off to change this.') : t('Enable revision-gated edits, creation and undo for this connection. Unsaved editor drafts are protected.') : t('This build does not support document editing.')}</small></div>
        <Switch label={t('Allow document editing')} on={allowWrites} disabled={locked || !status?.writesAvailable} onChange={setAllowWrites} /></div>
      <div className="sx-row wide"><div className="sx-tx"><b>{t('Connect an AI app')}</b><small>{t('One click adds Nevis to the app. Do this once; it keeps working after Nevis restarts. Restart the AI app afterwards.')}</small></div>
        <div className="sx-copy">{clients.map(c => <button key={c.id} className="ghost-btn" disabled={busy} onClick={() => void action(async () => { const file = await installClient(c.id); setMessage(t('Added to {file}. Restart {app}.', { file, app: c.label })) })}>{c.label}</button>)}
          <button className="ghost-btn" disabled={busy || !status} onClick={() => void action(async () => { await copyForAnyAi(status!); setMessage(t('Copied. Paste it into any AI app that supports MCP servers.')) })}>{t('Copy for another AI')}</button></div></div>
      {connected && <div className="sx-row wide"><div className="sx-tx"><b>{t('Manual connection')}</b><small>{t('Use a client that supports Streamable HTTP and a Bearer authorization header. Connection details contain a private token; share them only with your authorized client.')}</small></div>
        <div className="sx-copy"><code dir="ltr">{status?.endpoint}</code>
          <button className="primary" disabled={busy} onClick={() => void action(async () => { await copyConnection(status!); setMessage(t('Connection URL and authorization header copied.')) })}>{t('Copy connection details')}</button></div></div>}
      <details className="sx-adv">
        <summary><span>{t('Advanced: hide documents')}</span><small>{hiddenIds.length ? t('{n} hidden', { n: hiddenIds.length }) : t('Everything is visible')}</small></summary>
        <p className="sx-note">{t('Hidden documents and their sub-pages stay private, including history and search results. Turn the connection off to change this.')}</p>
        <div className="sx-pick" role="group" aria-label={t('Advanced: hide documents')}>
          {pages.map(page => <label key={page.id} className={hiddenIds.includes(page.id) ? 'off' : ''}>
            <input type="checkbox" checked={!hiddenIds.includes(page.id)} disabled={locked} onChange={event => setHidden(page.id, !event.target.checked)} />
            <span>{page.title || t('Untitled')}</span></label>)}
        </div>
      </details>
      {message && <p className="sx-note" role="status">{message}</p>}
    </div>
  </section>
}
