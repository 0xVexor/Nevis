import { useEffect, useMemo, useRef, useState } from 'react'
import { addVersion, listVersions, type Version } from './db'
import { docToHtml, hydrate } from './render'
import { ago } from './ui'
import type { Page } from './repo'
import { t } from './i18n'
import { confirmDialog, alertDialog } from './dialog'
import { contentProblem } from './editor/contentSafety'
import { structural } from './editor/layoutModel'
import * as Ic from './icons'
import { repo } from './store'

const words = (n: any): number => {
  const text = (x: any): string => (!x || typeof x === 'string' ? '' : (x.text ?? (x.content ?? []).map(text).join(' ')))
  const s = text(n).trim()
  return s ? s.split(/\s+/).length : 0
}

/** Earlier states of a page (kept automatically while you edit). Restoring first saves the current state, so it can be undone too. */
export function History({ page, editor, onClose }: { page: Page; editor: any; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [sel, setSel] = useState(0)
  const preview = useRef<HTMLDivElement>(null)

  useEffect(() => void listVersions(page.id).then(setVersions), [page.id])
  const v = versions?.[sel]
  const html = useMemo(() => (v ? docToHtml(v.content) : ''), [v])
  useEffect(() => {
    if (preview.current) void hydrate(preview.current)
  }, [html])

  const restore = async () => {
    if (!v || !editor.isEditable || editor.isDestroyed) return
    const before = editor.state.doc
    const issue = contentProblem(v.content, editor.schema)
    if (issue) { await alertDialog({ title: t('Version history'), message: t(issue) }); return }
    if (!(await confirmDialog({ title: t('Restore this version'), message: v.page ? t('Restore the saved content and page properties? The current version is kept first.') : t('Replace the current content of this page with this version? The current content is saved as a version first.'), confirmLabel: t('Restore') }))) return
    if (!editor.isEditable || editor.isDestroyed) return
    if (editor.state.doc !== before) return void alertDialog({ title: t('Restore this version'), message: t('The page changed while the dialog was open. Please try again.') })
    await addVersion({ pageId: page.id, ts: Date.now(), title: page.title, content: page.content, page: structuredClone(page) })
    repo.restoreVersion(page.id, v)
    editor.chain().command(({ tr }: any) => { structural(tr); return true }).setContent(v.content, { emitUpdate: false }).run()
    await repo.flushed()
    window.dispatchEvent(new CustomEvent('external-change', { detail: [page.id] }))
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal hist-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()} tabIndex={-1}>
        <div className="modal-head">
          <div>
            <b>{t('Version history')}</b>
            <small>{t('A version is saved automatically when you start editing, at most every 10 minutes.')}</small>
          </div>
          <button className="icon-btn" onClick={onClose} title={t('Close')}><Ic.Close size={16} /></button>
        </div>
        <div className="hist-body">
          <div className="hist-list">
            {versions === null ? null : versions.length === 0 ? (
              <div className="modal-empty">{t('No earlier versions yet.')}</div>
            ) : (
              versions.map((x, i) => (
                <button key={`${x.ts}:${i}`} className={'hist-row' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)}>
                  <b>{new Date(x.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
                  <small>{ago(x.ts)} · {t('{n} words', { n: words(x.content) })}</small>
                </button>
              ))
            )}
          </div>
          <div className="hist-preview">
            {v && <div className="hist-title" dir="auto">{v.title || t('Untitled')}</div>}
            <div className="tiptap" ref={preview} dangerouslySetInnerHTML={{ __html: html }} />
            {v && <button className="primary hist-restore" disabled={!editor.isEditable} onClick={restore}>{t('Restore this version')}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
