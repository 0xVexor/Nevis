// The sync state in the sidebar, drawn as the old app drew its indicator (`.sync-ind`): one quiet line, coloured by what needs the person.
// The numbers the tests and the owner's checklist read (online, not sent yet, files) stay as visually hidden text.
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import type { WsStatus } from '../workspace'
import { ago } from './ago'

type Tone = 'quiet' | 'busy' | 'attention' | 'error'

export function describeSync(s: WsStatus): { text: string; tone: Tone } {
  if (s.upgradeRequired) return { text: t('This app version is too old for this workspace'), tone: 'attention' }
  if (s.lastError) return { text: s.lastError, tone: 'error' }
  if (!s.online) return { text: t('Offline — will retry'), tone: 'quiet' }
  if (s.outbox > 0 || s.unsaved > 0 || s.files.pending > 0) return { text: t('Syncing…'), tone: 'busy' }
  return { text: s.lastSyncAt ? t('Synced · {time}', { time: ago(s.lastSyncAt) }) : t('Synced'), tone: 'quiet' }
}

const HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const

export function SyncIndicator({ status, onOpenSettings }: { status: WsStatus | null; onOpenSettings: () => void }) {
  const [, tick] = useState(0)
  useEffect(() => { const id = window.setInterval(() => tick(n => n + 1), 30_000); return () => window.clearInterval(id) }, [])
  if (!status) return null
  const info = describeSync(status)
  return (
    <div className="sync-ind">
      {(!status.online || info.tone !== 'quiet') && <button type="button" className="row plain sync-ind-main" data-tone={info.tone} title={info.text} onClick={onOpenSettings}>
        <span className="ic"><span className="sync-ind-dot" aria-hidden="true" /></span>
        <span className="ntitle" role="status" aria-live="polite">{info.text}</span>
      </button>}
      <div style={HIDDEN}>
        <span data-testid="net" data-online={status.online}>{status.online ? 'online' : 'offline'}</span>
        <span>{t('Not sent yet')}: <b data-testid="outbox">{status.outbox}</b></span>
        {status.files.pending > 0 && <span data-testid="files">{`${t('Files')}: ${status.files.pending}`}</span>}
        {status.files.error === 'quota' && <span data-testid="files-quota">{t('Your account is full: files stay on this device and nothing is lost, but they will not sync until there is room.')}</span>}
        {status.files.error === 'blob_too_large' && <span data-testid="files-too-large">{t('A file is larger than the server allows and stays on this device only.')}</span>}
        {status.upgradeRequired && <span data-testid="needs-app-update">{t('This app version is too old for this workspace; ')}<button onClick={() => location.reload()}>{t('Reload')}</button></span>}
        {status.lastError && <span data-testid="sync-error">{status.lastError}</span>}
      </div>
    </div>
  )
}
