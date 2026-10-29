import { useEffect, useMemo, useRef } from 'react'
import { docToHtml, hydrate } from './render'
import { contentProblem } from './editor/contentSafety'
import { extensions } from './editor/extensions'
import { getSchema } from '@tiptap/core'
import { conflictVersion } from './conflictDiff'
import { iconNode } from './iconSet'
import { t } from './i18n'
import * as Ic from './icons'

function Fields({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="cr-field-empty">—</span>
  if (typeof value !== 'object') return <span dir="auto">{typeof value === 'boolean' ? t(value ? 'Yes' : 'No') : String(value)}</span>
  return <dl className="cr-fields">{Object.entries(value).map(([key, field]) => <div key={key}><dt>{t(key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' '))}</dt><dd><Fields value={field} /></dd></div>)}</dl>
}
export function ConflictDocument({ encoded, changed = [] }: { encoded: string | null; changed?: number[] }) {
  const root = useRef<HTMLDivElement>(null)
  const version = useMemo(() => conflictVersion(encoded), [encoded])
  const data = useMemo(() => { try { return JSON.parse(version.raw) } catch { return null } }, [version.raw])
  const tags: string[] = Array.isArray(data?.tags) ? data.tags.filter((tag: unknown) => typeof tag === 'string') : []
  const content = data?.type === 'doc' ? data : data?.content
  const html = useMemo(() => {
    if (!content || contentProblem(content, getSchema(extensions))) return null
    return docToHtml(content)
  }, [content])
  useEffect(() => {
    const element = root.current
    if (!element || html === null) return
    // Use the same schema/styles/hydration as the editor's history preview. No save callback or mutable database UI is mounted.
    Array.from(element.children).forEach((child, index) => child.classList.toggle('cr-block-changed', changed.includes(index)))
    for (const input of element.querySelectorAll('input')) input.disabled = true
    void hydrate(element).catch(() => {})
  }, [html, changed])
  if (encoded === null) return <div className="cr-version-empty"><p>{t('This version has no file.')}</p></div>
  if (version.binary) return <div className="cr-version-empty"><p>{t('Binary attachment — choose a version or inspect the original file.')}</p></div>
  return <article className="cr-document" dir="auto">
    {version.title && <header className="page-head"><div className="cr-page-icon">{typeof data.icon === 'string' && data.icon ? iconNode(data.icon, 26) : <Ic.Page size={26} />}</div><h1 className="title" dir={data.titleDir || 'auto'}>{version.title}</h1></header>}
    {(tags.length > 0 || typeof data?.status === 'string') && <div className="cr-page-meta">{tags.map((tag: string) => <span className="tag-chip static" key={tag}>{tag}</span>)}{typeof data?.status === 'string' && <span>{t(data.status)}</span>}</div>}
    {html !== null ? <div ref={root} className="tiptap" onClick={e => { if ((e.target as Element).closest('a')) e.preventDefault() }} dangerouslySetInnerHTML={{ __html: html }} /> : data ? <Fields value={data} /> : <p className="cr-plain-text">{version.text}</p>}
    {html !== null && data?.database && <details className="cr-properties"><summary>{t('Properties')}</summary><Fields value={data.database} /></details>}
  </article>
}
