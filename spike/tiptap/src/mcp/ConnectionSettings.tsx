import { Switch } from '../design-system/controls'
import { Button, Checkbox, Disclosure, PreferenceGroup, PreferenceRow } from '../design-system'
import { useEffect, useRef, useState } from 'react'
import { isTauri } from '../db'
import { t } from '../i18n'
import { repo } from '../store'
import { connectionStatus, copyConnection, copyForAnyAi, disableConnection, enableConnection, installClient } from './bridge'
import type { AiClient } from './bridge'
import type { McpStatus } from './bridge'

const clients: { id: AiClient; label: string }[] = [
  { id: 'claude', label: 'Claude Desktop' },
  { id: 'codex', label: 'ChatGPT / Codex' },
  { id: 'gemini', label: 'Gemini CLI' },
]

/** One switch turns the connection on for the whole vault; hiding single documents lives under "Advanced". */
export function McpConnectionSettings() {
  const revision = useRef<string | null>(null)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [allowWrites, setAllowWrites] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const pages = repo
    .list()
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
  useEffect(() => {
    if (!isTauri) return
    let active = true
    const refresh = () =>
      connectionStatus()
        .then((value) => {
          if (active) {
            if (value.connection && revision.current !== value.connection.revision) {
              revision.current = value.connection.revision
              setAllowWrites(value.connection.policy.allowWrites)
              setHiddenIds(value.connection.policy.excludedIds)
            }
            setStatus(value)
          }
        })
        .catch(() => {
          if (active) setMessage(t('Connection status is unavailable.'))
        })
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
  const action = async (run: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try {
      await run()
    } catch (e) {
      setMessage(t('Could not complete the connection action. Check that the vault is open and try again.') + ' (' + (e instanceof Error ? e.message : String(e)).slice(0, 120) + ')')
    } finally {
      setBusy(false)
    }
  }
  const title = t('AI connection')
  const hint = t('Let an AI app read, and optionally edit, the documents in this vault. It works only while Nevis is open.')
  if (!isTauri)
    return (
      <PreferenceGroup title={title} hint={hint}>
        <p className="prefs-note">{t('Local agent connections are available in the desktop app.')}</p>
      </PreferenceGroup>
    )
  const connected = !!status?.active
  const locked = busy || connected
  const toggle = (on: boolean) =>
    void action(async () => {
      if (on) setStatus(await enableConnection({ wholeVault: true, rootIds: [], excludedIds: hiddenIds, allowWrites }))
      else {
        await disableConnection()
        setStatus(await connectionStatus())
      }
    })
  const setHidden = (id: string, hidden: boolean) => setHiddenIds((ids) => (hidden ? [...ids, id] : ids.filter((x) => x !== id)))
  return (
    <PreferenceGroup title={title} hint={hint}>
      <PreferenceRow
        label={t('Allow AI access')}
        hint={connected ? (status?.ready ? t('Connected. Switching vaults or reloading the app disconnects the client.') : t('Enabled, but the app bridge is unavailable.')) : t('Off. Nothing can reach your documents.')}
      >
        <Switch label={t('Allow AI access')} checked={connected} disabled={busy || !status || (!connected && !status.ready)} onChange={toggle} />
      </PreferenceRow>
      <PreferenceRow
        label={t('Allow document editing')}
        hint={
          status?.writesAvailable
            ? connected
              ? t('Turn the connection off to change this.')
              : t('Enable revision-gated edits, creation and undo for this connection. Unsaved editor drafts are protected.')
            : t('This build does not support document editing.')
        }
      >
        <Switch label={t('Allow document editing')} checked={allowWrites} disabled={locked || !status?.writesAvailable} onChange={setAllowWrites} />
      </PreferenceRow>
      <PreferenceRow wide label={t('Connect an AI app')} hint={t('One click adds Nevis to the app. Do this once; it keeps working after Nevis restarts. Restart the AI app afterwards.')}>
        {clients.map((c) => (
          <Button
            key={c.id}
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const file = await installClient(c.id)
                setMessage(t('Added to {file}. Restart {app}.', { file, app: c.label }))
              })
            }
          >
            {c.label}
          </Button>
        ))}
        <Button
          disabled={busy || !status}
          onClick={() =>
            void action(async () => {
              await copyForAnyAi(status!)
              setMessage(t('Copied. Paste it into any AI app that supports MCP servers.'))
            })
          }
        >
          {t('Copy for another AI')}
        </Button>
      </PreferenceRow>
      {connected && (
        <PreferenceRow
          wide
          label={t('Manual connection')}
          hint={t('Use a client that supports Streamable HTTP and a Bearer authorization header. Connection details contain a private token; share them only with your authorized client.')}
        >
          <code className="prefs-code" dir="ltr">
            {status?.endpoint}
          </code>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await copyConnection(status!)
                setMessage(t('Connection URL and authorization header copied.'))
              })
            }
          >
            {t('Copy connection details')}
          </Button>
        </PreferenceRow>
      )}
      <Disclosure className="prefs-disclosure" title={`${t('Advanced: hide documents')} · ${hiddenIds.length ? t('{n} hidden', { n: hiddenIds.length }) : t('Everything is visible')}`}>
        <p className="prefs-note">{t('Hidden documents and their sub-pages stay private, including history and search results. Turn the connection off to change this.')}</p>
        <div className="prefs-pick" role="group" aria-label={t('Advanced: hide documents')}>
          {pages.map((page) => (
            <Checkbox key={page.id} checked={!hiddenIds.includes(page.id)} disabled={locked} onChange={(on) => setHidden(page.id, !on)}>
              <span dir="auto">{page.title || t('Untitled')}</span>
            </Checkbox>
          ))}
        </div>
      </Disclosure>
      {message && (
        <p className="prefs-note" role="status">
          {message}
        </p>
      )}
    </PreferenceGroup>
  )
}
