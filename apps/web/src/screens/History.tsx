// Page history, drawn as the old app drew it (the dialog with a list of versions and a preview). Restoring saves the current state first, so it
// can be undone too; the restore itself is an ordinary edit of the page, so it syncs like any other.
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { Version } from '@nevis/core'
import { createEditor } from '@nevis/editor'
import { writeBody, type PMJson } from '@nevis/schema'
import { Button, Dialog } from '../ds'
import { t } from '../i18n'
import { ago } from '../shell/ago'
import type { Workspace } from '../workspace'

const words = (json: string): number => {
  const text = (n: { text?: string; content?: unknown[] } | undefined): string => (!n ? '' : (n.text ?? ((n.content ?? []) as { text?: string; content?: unknown[] }[]).map(text).join(' ')))
  try { const s = text(JSON.parse(json)).trim(); return s ? s.split(/\s+/).length : 0 } catch { return 0 }
}

export function History({ ws, id, title, onClose }: { ws: Workspace; id: string; title: string; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [sel, setSel] = useState(0)
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => { void ws.versions(id).then(setVersions) }, [ws, id])
  const v = versions?.[sel]
  useEffect(() => {
    if (!v || !preview.current) return
    const doc = new Y.Doc()
    writeBody(doc, JSON.parse(v.json) as PMJson)
    const ed = createEditor(doc, preview.current)
    ed.setEditable(false)
    return () => ed.destroy()
  }, [v])
  const restore = async () => { if (!v) return; await ws.restoreVersion(id, v); onClose() }
  const saveNow = async () => { await ws.saveVersion(id, true); setVersions(await ws.versions(id)); setSel(0) }
  return (
    <Dialog open wide title={t('Version history')} onClose={onClose} actions={<>
      <Button data-testid="history-save" onClick={() => void saveNow()}>{t('Save a version now')}</Button>
      {v && <Button variant="primary" data-testid="history-restore" onClick={() => void restore()}>{t('Restore this version')}</Button>}
    </>}>
      <p className="hist-hint">{t('A version is saved automatically 5 minutes after you stop editing.')}</p>
      <div className="hist-body" data-testid="history">
        <div className="hist-list">
          {versions === null ? null : versions.length === 0 ? <p className="ds-empty">{t('No earlier versions yet.')}</p> : versions.map((x, i) => (
            <button key={x.id} type="button" className="hist-row" data-testid="history-row" aria-pressed={i === sel} onClick={() => setSel(i)}>
              <b>{new Date(x.at).toLocaleString('fa', { dateStyle: 'medium', timeStyle: 'short' })}{x.manual ? ' ★' : ''}</b>
              <small>{ago(x.at)} · {t('{n} words', { n: words(x.json) })}{x.label ? ` · ${x.label}` : ''}</small>
            </button>
          ))}
        </div>
        <div className="hist-preview">
          {v && <div className="hist-title"><span dir="auto">{title || t('Untitled')}</span></div>}
          <div className="tiptap" ref={preview} data-testid="history-preview" />
        </div>
      </div>
    </Dialog>
  )
}
