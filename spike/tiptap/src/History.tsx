import type { CommandProps } from '@tiptap/core'
import { Button, Dialog } from './design-system'
import type { Editor } from '@tiptap/core'
import type { DocNode } from './docNode'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addVersion, listVersions, type Version } from './db'
import { docToHtml, hydrate } from './render'
import { ago } from './ui'
import type { Page } from './repo'
import { t } from './i18n'
import { confirmDialog, alertDialog } from './dialog'
import { contentProblem } from './editor/contentSafety'
import { structural } from './editor/layoutModel'

const words = (n: DocNode | string | null | undefined): number => {
  const text = (x: DocNode | string | null | undefined): string => (!x || typeof x === 'string' ? '' : (x.text ?? (x.content ?? []).map(text).join(' ')))
  const s = text(n).trim()
  return s ? s.split(/\s+/).length : 0
}

/** Earlier states of a page (kept automatically while you edit). Restoring first saves the current state, so it can be undone too. */
export function History({ page, editor, onClose }: { page: Page; editor: Editor; onClose: () => void }) {
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
    if (!v || !editor.isEditable) return
    const issue = contentProblem(v.content, editor.schema)
    if (issue) return void alertDialog({ title: t('Restore this version'), message: t(issue) })
    const before = editor.state.doc
    if (
      !(await confirmDialog({
        title: t('Restore this version'),
        message: t('Replace the current content of this page with this version? The current content is saved as a version first.'),
        confirmLabel: t('Restore'),
      }))
    )
      return
    if (!editor.isEditable || editor.isDestroyed) return
    if (editor.state.doc !== before) return void alertDialog({ title: t('Restore this version'), message: t('The page changed while the dialog was open. Please try again.') })
    await addVersion({ pageId: page.id, ts: Date.now(), title: page.title, content: editor.getJSON() })
    editor
      .chain()
      .command(({ tr }: CommandProps) => {
        structural(tr)
        return true
      })
      .setContent(v.content)
      .run()
    onClose()
  }

  return (
    <Dialog
      open
      wide
      title={t('Version history')}
      onClose={onClose}
      actions={
        v && (
          <Button variant="primary" disabled={!editor.isEditable} onClick={restore}>
            {t('Restore this version')}
          </Button>
        )
      }
    >
      <p className="hist-hint">{t('A version is saved automatically when you start editing, at most every 10 minutes.')}</p>
      <div className="hist-body">
        <div className="hist-list">
          {versions === null ? null : versions.length === 0 ? (
            <p className="ds-empty">{t('No earlier versions yet.')}</p>
          ) : (
            versions.map((x, i) => (
              <button key={x.ts} type="button" className="hist-row" aria-pressed={i === sel} onClick={() => setSel(i)}>
                <b>{new Date(x.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
                <small>
                  {ago(x.ts)} · {t('{n} words', { n: words(x.content) })}
                </small>
              </button>
            ))
          )}
        </div>
        <div className="hist-preview">
          {v && (
            <div className="hist-title">
              <span dir="auto">{v.title || t('Untitled')}</span>
            </div>
          )}
          <div className="tiptap" ref={preview} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </Dialog>
  )
}
