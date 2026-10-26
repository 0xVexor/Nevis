// Rich text cell editor: a small contentEditable with bold / italic / code / strike / link / @page mention. The stored value is a
// RichRun[] (handoff §5), so formatting and mentions survive reload; this component only converts DOM <-> runs.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RichRun } from '../model/types.ts'
import { isSafeUrl } from '../props/registry.ts'
import { matchKey } from '../text.ts'
import { t } from '../../i18n'
import { promptDialog } from '../../dialog'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function runsToHtml(runs: RichRun[]): string {
  return runs
    .map((r) => {
      if (r.mention) return `<span data-mention="${esc(r.mention.id)}" data-kind="${r.mention.kind}" contenteditable="false" class="db-mention">@${esc(r.text)}</span>`
      let h = esc(r.text).replace(/\n/g, '<br>')
      if (r.code) h = `<code>${h}</code>`
      if (r.bold) h = `<b>${h}</b>`
      if (r.italic) h = `<i>${h}</i>`
      if (r.strike) h = `<s>${h}</s>`
      if (r.underline) h = `<u>${h}</u>`
      if (r.href) h = `<a href="${esc(r.href)}">${h}</a>`
      return h
    })
    .join('')
}

type Flags = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; href?: string }

export function domToRuns(root: HTMLElement): RichRun[] {
  const out: RichRun[] = []
  const push = (text: string, f: Flags, mention?: RichRun['mention']) => {
    if (!text && !mention) return
    const prev = out[out.length - 1]
    const same = prev && !prev.mention && !mention && !!prev.bold === !!f.bold && !!prev.italic === !!f.italic && !!prev.underline === !!f.underline && !!prev.strike === !!f.strike && !!prev.code === !!f.code && prev.href === f.href
    if (same) prev.text += text
    else out.push({ text, ...(f.bold ? { bold: true } : {}), ...(f.italic ? { italic: true } : {}), ...(f.underline ? { underline: true } : {}), ...(f.strike ? { strike: true } : {}), ...(f.code ? { code: true } : {}), ...(f.href ? { href: f.href } : {}), ...(mention ? { mention } : {}) })
  }
  const walk = (n: Node, f: Flags, first: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) return push((n.textContent ?? '').replace(/​/g, ''), f)
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as HTMLElement
    const tag = el.tagName
    if (el.dataset.mention) return push(el.textContent?.replace(/^@/, '') ?? '', f, { kind: (el.dataset.kind as 'page' | 'person') ?? 'page', id: el.dataset.mention })
    if (tag === 'BR') return push('\n', f)
    const next: Flags = { ...f }
    if (tag === 'B' || tag === 'STRONG' || el.style.fontWeight === 'bold' || Number(el.style.fontWeight) >= 600) next.bold = true
    if (tag === 'I' || tag === 'EM' || el.style.fontStyle === 'italic') next.italic = true
    if (tag === 'U') next.underline = true
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strike = true
    if (tag === 'CODE') next.code = true
    if (tag === 'A') {
      const h = el.getAttribute('href') ?? ''
      if (isSafeUrl(h)) next.href = h
    }
    const block = tag === 'DIV' || tag === 'P'
    if (block && !first) push('\n', f)
    el.childNodes.forEach((c, i) => walk(c, next, i === 0 && first))
  }
  root.childNodes.forEach((c, i) => walk(c, {}, i === 0))
  while (out.length && !out[out.length - 1].mention && out[out.length - 1].text.endsWith('\n')) {
    out[out.length - 1].text = out[out.length - 1].text.slice(0, -1)
    if (!out[out.length - 1].text) out.pop()
  }
  return out
}

export function RichTextEditor({ runs, pages, onCommit, onCancel, autoFocus = true }: { runs: RichRun[]; pages: () => { id: string; title: string }[]; onCommit: (runs: RichRun[]) => void; onCancel: () => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  const [mention, setMention] = useState<string | null>(null)
  const initial = useMemo(() => runsToHtml(runs), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoFocus || !ref.current) return
    ref.current.focus()
    const sel = window.getSelection()
    sel?.selectAllChildren(ref.current)
    sel?.collapseToEnd()
  }, [autoFocus])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit && ref.current) onCommit(domToRuns(ref.current))
    else onCancel()
  }
  const cmd = (c: string) => {
    ref.current?.focus()
    document.execCommand(c)
  }
  const link = async () => {
    const url = await promptDialog({ title: t('Link'), message: t('Address'), initial: 'https://', ltr: true })
    if (url && isSafeUrl(url)) {
      ref.current?.focus()
      document.execCommand('createLink', false, url)
    }
  }
  const matches = mention !== null ? pages().filter((p) => matchKey(p.title).includes(matchKey(mention))).slice(0, 6) : []
  const insertMention = (p: { id: string; title: string }) => {
    ref.current?.focus()
    const html = `<span data-mention="${esc(p.id)}" data-kind="page" contenteditable="false" class="db-mention">@${esc(p.title || t('Untitled'))}</span>&nbsp;`
    document.execCommand('insertHTML', false, html)
    setMention(null)
  }
  return (
    <div className="db-rich-ed" onMouseDown={(e) => e.stopPropagation()}>
      <div className="db-rich-bar" role="toolbar" aria-label={t('Text formatting')}>
        <button type="button" title={t('Bold') + ' (Ctrl+B)'} onMouseDown={(e) => (e.preventDefault(), cmd('bold'))}><b>B</b></button>
        <button type="button" title={t('Italic') + ' (Ctrl+I)'} onMouseDown={(e) => (e.preventDefault(), cmd('italic'))}><i>I</i></button>
        <button type="button" title={t('Strikethrough')} onMouseDown={(e) => (e.preventDefault(), cmd('strikeThrough'))}><s>S</s></button>
        <button type="button" title={t('Link')} onMouseDown={(e) => (e.preventDefault(), void link())}>🔗</button>
        <button type="button" title={t('Mention a page')} onMouseDown={(e) => (e.preventDefault(), setMention(''))}>@</button>
      </div>
      <div
        ref={ref}
        className="db-rich-box"
        contentEditable
        suppressContentEditableWarning
        dir="auto"
        role="textbox"
        aria-multiline="true"
        aria-label={t('Text')}
        dangerouslySetInnerHTML={{ __html: initial }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return // never act on Enter / Tab while an IME composition is open
          if (e.key === 'Escape') { e.preventDefault(); finish(false) }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true) }
          else if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak') }
          else if (e.key === '@') setMention('')
          else if (mention !== null && e.key.length === 1) setMention(mention + e.key)
          else if (mention !== null && e.key === 'Backspace') setMention(mention.length ? mention.slice(0, -1) : null)
        }}
        onPaste={(e) => {
          e.preventDefault() // only plain text: pasted HTML never brings foreign styles or scripts in
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
        }}
        onBlur={() => window.setTimeout(() => !mention && finish(true), 0)}
      />
      {mention !== null && (
        <div className="db-rich-mentions" role="listbox">
          {matches.length === 0 && <div className="db-empty-hint">{t('No pages found')}</div>}
          {matches.map((p) => (
            <button key={p.id} type="button" role="option" onMouseDown={(e) => (e.preventDefault(), insertMention(p))}>
              {p.title || t('Untitled')}
            </button>
          ))}
        </div>
      )}
      <div className="db-rich-foot">{t('Ctrl+Enter to save, Esc to cancel')}</div>
    </div>
  )
}
