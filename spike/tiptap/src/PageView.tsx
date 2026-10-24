import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import { getFind, scrollToMatch } from './editor/find'
import { looksLikeMermaid } from './editor/mermaid'
import { BubbleMenu } from '@tiptap/react/menus'
import { extensions } from './editor/extensions'
import { repo } from './store'
import type { Page, PageStatus } from './repo'
import { STATUS, addTag, allTags } from './meta'
import { History } from './History'
import { normalizeFa } from './normalize'
import { getTemplates, type Template } from './templates'
import { OPEN_PAGE } from './editor/pageLink'
import { ago, EmojiPicker, Popover, Select } from './ui'
import { iconNode, plainIcon } from './iconSet'
import * as Ic from './icons'
import { Toolbar } from './Toolbar'
import { t } from './i18n'

export type SaveState = 'saved' | 'saving'

const isCellSel = (s: any) => !!s.$anchorCell

// BubbleMenu re-registers its plugin whenever these props change identity, which dispatches a transaction
// and re-renders us: keep them module-level so the menus mount once.
const TABLE_OPTS = { placement: 'top-start' as const, offset: 6 }
const showTable = ({ editor, state }: any) => editor.isEditable && editor.isActive('table') && (state.selection.empty || isCellSel(state.selection))
const BTN = (props: { label: React.ReactNode; title?: string; on?: boolean; run: (c: any) => any; editor: any; wide?: boolean }) => (
  <button
    className={(props.on ? 'on ' : '') + (props.wide ? 'wide' : '')}
    title={props.title}
    onMouseDown={(e) => e.preventDefault()}
    onClick={() => props.run(props.editor.chain().focus()).run()}
  >
    {props.label}
  </button>
)

const TITLE_CMDS = [
  { id: 'rtl', title: 'Right-to-left (RTL)', desc: 'Make the title right-to-left', kw: 'rtl direction right to left جهت راست چین' },
  { id: 'ltr', title: 'Left-to-right (LTR)', desc: 'Make the title left-to-right', kw: 'ltr direction left to right جهت چپ چین' },
  { id: 'auto', title: 'Auto direction', desc: 'Detect direction from the text', kw: 'auto direction خودکار جهت' },
]

export function PageView({ page, onSave, onMeta, onCover, readOnly = false }: { page: Page; onSave: (s: SaveState) => void; onMeta: () => void; onCover: (anchor: DOMRect) => void; readOnly?: boolean }) {
  const timer = useRef<number>(0)
  const editorRef = useRef<any>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const [icon, setIcon] = useState(page.icon)
  const [backs, setBacks] = useState<Page[]>([])
  // in an effect so the page we just left has already flushed its last edit
  useEffect(() => setBacks(repo.backlinks(page.id)), [page.id])
  const [titleDir, setTitleDir] = useState(page.titleDir)
  // tags + status shown under the title
  const [tags, setTags] = useState<string[]>(page.tags ?? [])
  const [status, setStatus] = useState<PageStatus | undefined>(page.status)
  const saveTags = (next: string[]) => {
    setTags(next)
    repo.update(page.id, { tags: next })
    onMeta()
  }
  const [tmenu, setTmenu] = useState<{ q: string; sel: number; start: number; caret: number } | null>(null)

  const tItems = tmenu ? TITLE_CMDS.filter((c) => !tmenu.q || normalizeFa(`${t(c.title)} ${c.title} ${c.kw}`).includes(normalizeFa(tmenu.q))) : []
  const checkSlash = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length
    const m = el.value.slice(0, caret).match(/(^|\s)\/([^\s/]*)$/)
    setTmenu(m ? { q: m[2], sel: 0, start: caret - m[2].length - 1, caret } : null)
  }
  const applyTitleCmd = (c: (typeof TITLE_CMDS)[number]) => {
    const el = titleRef.current
    if (!el || !tmenu) return
    const after = el.value.slice(tmenu.caret)
    const before = el.value.slice(0, tmenu.start)
    const v = (after ? before : before.trimEnd()) + after // no dangling space when the command was at the end
    el.value = v
    const dir = c.id === 'auto' ? undefined : (c.id as 'rtl' | 'ltr')
    setTitleDir(dir)
    repo.update(page.id, { title: v, titleDir: dir })
    setTmenu(null)
    onMeta()
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(tmenu.start, tmenu.start)
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    })
  }

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      repo.update(page.id, { content: ed.getJSON() })
      onSave('saved')
    }
  }, [page.id, onSave])

  const editor = useEditor(
    {
      extensions,
      content: page.content,
      editable: !readOnly,
      shouldRerenderOnTransaction: true,
      editorProps: { attributes: { spellcheck: 'false' } },
      onUpdate: () => {
        onSave('saving')
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(flush, 400)
      },
    },
    [page.id],
  )
  editorRef.current = editor
  // reader mode: the same editor, locked (no typing, no editing widgets), so scrolling and selecting still work
  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly)
  }, [editor, readOnly])
  // the page picker (`[[`, `@`) must not offer the page you are on
  useEffect(() => {
    if (editor) (editor.storage as any).currentPageId = page.id
  }, [editor, page.id])

  useEffect(() => {
    if (editor && typeof page.content === 'string') repo.update(page.id, { content: editor.getJSON() })
  }, [editor, page.id, page.content])

  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush() // switching pages must not lose the last keystrokes
    }
  }, [flush])

  const fit = () => {
    const t = titleRef.current
    if (t) (t.style.height = 'auto', (t.style.height = t.scrollHeight + 'px'))
  }
  useEffect(fit, [page.id])
  // the height is inline, so it must be recomputed when the width changes (window resize, sidebar toggle) or the font arrives
  useEffect(() => {
    const t = titleRef.current
    if (!t) return
    let w = t.clientWidth
    const ro = new ResizeObserver(() => {
      if (t.clientWidth !== w) {
        w = t.clientWidth
        requestAnimationFrame(fit) // resizing inside the observer callback would trigger the "ResizeObserver loop" warning
      }
    })
    ro.observe(t)
    document.fonts?.ready.then(fit)
    return () => ro.disconnect()
  }, [page.id])
  useEffect(() => {
    if (!page.title) titleRef.current?.focus()
  }, [page.id, page.title])

  // ───── version history (opened from the page panel via a window event) ─────
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    const open = () => setHistoryOpen(true)
    window.addEventListener('open-history', open)
    return () => window.removeEventListener('open-history', open)
  }, [])

  // ───── find in page (Ctrl+F) ─────
  const [findOpen, setFindOpen] = useState(false)
  const findInput = useRef<HTMLInputElement>(null)
  const stepFind = (dir: 1 | -1) => (editor?.commands as any).stepFind(dir)
  const closeFind = () => {
    ;(editor?.commands as any).clearFind()
    setFindOpen(false)
    editor?.commands.focus()
  }
  useEffect(() => {
    if (!editor) return
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault() // replaces the browser's own find: ours understands Persian letter variants and ZWNJ
        const { from, to } = editor.state.selection
        const picked = from !== to ? editor.state.doc.textBetween(from, to, ' ') : ''
        setFindOpen(true)
        requestAnimationFrame(() => {
          const el = findInput.current
          if (!el) return
          if (picked && !picked.includes('\n')) {
            el.value = picked
            ;(editor.commands as any).setFind(picked)
            scrollToMatch(editor)
          }
          el.focus()
          el.select()
        })
      } else if (e.key === 'F3' || (mod && e.key.toLowerCase() === 'g')) {
        e.preventDefault()
        stepFind(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [editor])

  // ───── outline: rendered into the slot of the page panel (if the panel is open) ─────
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = document.getElementById('outline-slot')
    setSlot((s) => (s === el ? s : el))
  })

  if (!editor) return null

  const applyTemplate = (t: Template) => {
    editor.commands.setContent(t.html)
    if (!titleRef.current?.value.trim()) {
      titleRef.current!.value = t.pageTitle
      repo.update(page.id, { title: t.pageTitle })
      fit()
    }
    if (!icon) (repo.update(page.id, { icon: t.icon }), setIcon(t.icon))
    onMeta()
    // let the user finish the title ("جلسه‌ی درس — …") right away
    requestAnimationFrame(() => {
      const el = titleRef.current
      if (el) (el.focus(), el.setSelectionRange(el.value.length, el.value.length))
    })
  }

  // selected paragraphs that are Mermaid source (e.g. pasted as plain text): offer to turn them into a diagram
  const diagram = (() => {
    const { $from, $to, empty } = editor.state.selection
    if (empty) return null
    // whole top-level blocks; Ctrl+A (select all) starts and ends at depth 0, i.e. the whole document
    const from = $from.depth >= 1 ? $from.before(1) : $from.pos
    const to = $to.depth >= 1 ? $to.after(1) : $to.pos
    const code = editor.state.doc.textBetween(from, to, '\n', ' ').trim()
    return looksLikeMermaid(code) ? { from, to, code } : null
  })()

  const find = getFind(editor)
  const heads: { level: number; text: string; pos: number }[] = []
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'heading') heads.push({ level: n.attrs.level, text: n.textContent.trim(), pos })
    return n.type.name !== 'heading'
  })
  const gotoHeading = (pos: number) => {
    const el = editor.view.nodeDOM(pos) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="page">
      {findOpen && (
        <div className="findbar" role="search">
          <input
            ref={findInput}
            dir="auto"
            placeholder={t('Search in this page…')}
            onChange={(e) => {
              ;(editor.commands as any).setFind(e.target.value)
              scrollToMatch(editor)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), stepFind(e.shiftKey ? -1 : 1))
              else if (e.key === 'Escape') (e.preventDefault(), closeFind())
            }}
          />
          <span className="find-count">{find.matches.length ? t('{i} of {n}', { i: find.index + 1, n: find.matches.length }) : find.query ? t('Not found') : ''}</span>
          <button title={t('Previous  Shift+Enter')} onClick={() => stepFind(-1)}>▲</button>
          <button title={t('Next  Enter')} onClick={() => stepFind(1)}>▼</button>
          <button title={t('Close  Esc')} onClick={closeFind}>✕</button>
        </div>
      )}
      {slot &&
        createPortal(
          <section>
            <h4>{t('Outline')}</h4>
            {heads.length === 0 && <div className="pd-note">{t('Add headings (H1–H3) and the outline will appear here.')}</div>}
            {heads.map((h) => (
              <button key={h.pos} className="pd-row ol" style={{ paddingInlineStart: 10 + (h.level - 1) * 14 }} onClick={() => gotoHeading(h.pos)} dir="auto">
                {h.text || t('Untitled')}
              </button>
            ))}
          </section>,
          slot,
        )}
      <div className="page-head">
        <div className="page-top">
          <button className={'page-icon' + (icon ? '' : ' empty')} onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} title={t('Change icon')}>
            {icon ? <span className="page-icon-g">{iconNode(icon, 40)}</span> : <Ic.Page size={44} />}
          </button>
          <div className="page-tools">
            {!icon && <button onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}><Ic.Star size={14} />{t('Add icon')}</button>}
            {!page.cover && <button onClick={(e) => onCover(e.currentTarget.getBoundingClientRect())}><Ic.Image size={14} />{t('Add cover')}</button>}
          </div>
        </div>
        {picker && (
          <Popover anchor={picker} onClose={() => setPicker(null)}>
            <EmojiPicker
              onPick={(e) => (repo.update(page.id, { icon: e }), setIcon(e), setPicker(null), onMeta())}
              onClear={() => (repo.update(page.id, { icon: undefined }), setIcon(undefined), setPicker(null), onMeta())}
            />
          </Popover>
        )}
        <textarea
          ref={titleRef}
          readOnly={readOnly}
          className="title"
          dir={titleDir ?? 'auto'}
          rows={1}
          placeholder={t('Untitled')}
          defaultValue={page.title}
          onInput={fit}
          onChange={(e) => {
            repo.update(page.id, { title: e.target.value.replace(/\n/g, ' ') })
            onMeta()
            checkSlash(e.target)
          }}
          onClick={(e) => checkSlash(e.currentTarget)}
          onBlur={() => setTmenu(null)}
          onKeyDown={(e) => {
            if (tmenu && tItems.length) {
              const move = (d: number) => (e.preventDefault(), setTmenu({ ...tmenu, sel: (tmenu.sel + d + tItems.length) % tItems.length }))
              if (e.key === 'ArrowDown') return move(1)
              if (e.key === 'ArrowUp') return move(-1)
              if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), applyTitleCmd(tItems[tmenu.sel]))
              if (e.key === 'Escape') return (e.preventDefault(), setTmenu(null))
            }
            if (e.key === 'Enter') (e.preventDefault(), editor.commands.focus('start'))
          }}
        />
        {tmenu && (
          <div className="slash-menu title-menu">
            <div className="slash-label">{t('Title direction')}</div>
            {tItems.length === 0 && <div className="slash-empty">{t('No items found')}</div>}
            {tItems.map((c, i) => (
              <button
                key={c.id}
                className={'slash-item' + (i === tmenu.sel ? ' sel' : '')}
                onMouseDown={(e) => (e.preventDefault(), applyTitleCmd(c))}
                onMouseMove={() => i !== tmenu.sel && setTmenu({ ...tmenu, sel: i })}
              >
                <span className="slash-ic"><Ic.Direction size={16} /></span>
                <span className="slash-tx">
                  <b>{t(c.title)}</b>
                  <small>{t(c.desc)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="page-meta">
        <div className="meta-row">
        <div className="meta-cell tags">
          <span className="meta-ic" title={t('Tags')}><Ic.Tag size={16} /></span>
          <div className="meta-body">
            <span className="meta-label">{t('Tags')}</span>
            <div className="meta-val">
        {tags.map((tag) => (
          <span key={tag} className="tag-chip static" dir="auto" style={{ ['--hue' as string]: [...tag].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7) } as React.CSSProperties}>
            {tag}
            <button title={t('Remove')} onClick={() => saveTags(tags.filter((x) => x !== tag))}>×</button>
          </span>
        ))}
        <input
          className="tag-input"
          dir="auto"
          list="tag-list"
          placeholder={t('Add tag…')}
          title={t('Add tag…')}
          onKeyDown={(e) => {
            const el = e.currentTarget
            if ((e.key === 'Enter' || e.key === ',' || e.key === '،') && el.value.trim()) {
              e.preventDefault()
              saveTags(addTag(tags, el.value))
              el.value = ''
            } else if (e.key === 'Backspace' && !el.value && tags.length) saveTags(tags.slice(0, -1))
          }}
          onBlur={(e) => {
            if (e.currentTarget.value.trim()) (saveTags(addTag(tags, e.currentTarget.value)), (e.currentTarget.value = ''))
          }}
        />
        <datalist id="tag-list">
          {allTags(repo.pagesOnly())
            .filter((x) => !tags.some((y) => normalizeFa(y) === normalizeFa(x)))
            .map((x) => <option key={x} value={x} />)}
        </datalist>
            </div>
          </div>
        </div>
        <div className="meta-cell">
          <span className="meta-ic"><Ic.Flag size={16} /></span>
          <div className="meta-body">
            <span className="meta-label">{t('Status')}</span>
            <div className="meta-val">
        <Select
          className={'status-sel' + (status ? ' has' : '')}
          style={status ? ({ ['--st' as string]: STATUS[status].color } as React.CSSProperties) : undefined}
          value={status ?? ''}
          title={t('Status')}
          onChange={(val) => {
            const v = (val || undefined) as PageStatus | undefined
            setStatus(v)
            repo.update(page.id, { status: v })
            onMeta()
          }}
          options={[{ value: '', label: t('No status') }, ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ value: s, label: t(STATUS[s].label), color: STATUS[s].color }))]}
        />
            </div>
          </div>
        </div>
        </div>
        <div className="meta-row">
        <div className="meta-cell">
          <button
            className={'meta-ic like' + (page.favorite ? ' on' : '')}
            title={page.favorite ? t('Remove from favorites') : t('Add to favorites')}
            aria-pressed={!!page.favorite}
            onClick={() => (repo.update(page.id, { favorite: !page.favorite }), onMeta())}
          >
            <Ic.Star size={16} filled={page.favorite} />
          </button>
          <div className="meta-body">
            <span className="meta-label">{t('Favorite')}</span>
            <div className="meta-val"><span className="meta-text">{page.favorite ? t('Yes') : t('No')}</span></div>
          </div>
        </div>
        <div className="meta-cell">
          <span className="meta-ic"><Ic.Clock size={16} /></span>
          <div className="meta-body">
            <span className="meta-label">{t('Last edited')}</span>
            <div className="meta-val"><span className="meta-text">{ago(page.updatedAt)}</span></div>
          </div>
        </div>
        </div>
      </div>

      {!readOnly && editor.isEmpty && !editor.isFocused && (
        <div className="templates">
          <span className="templates-label">{t('Quick start with a template')}</span>
          {getTemplates().map((t) => (
            <button key={t.id} title={t.desc} onClick={() => applyTemplate(t)}>
              <span>{t.icon}</span>
              {t.title}
            </button>
          ))}
        </div>
      )}

      {!readOnly && <Toolbar editor={editor} diagram={diagram} />}
      <EditorContent editor={editor} className="ec" />

      {historyOpen && <History page={page} editor={editor} onClose={() => setHistoryOpen(false)} />}

      {backs.length > 0 && (
        <section className="backlinks">
          <div className="backlinks-title">{t('Backlinks')} · {backs.length}</div>
          {backs.map((b) => (
            <button key={b.id} className="backlink" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: b.id }))}>
              <span className="backlink-ic">{plainIcon(b.icon)}</span>
              <span dir="auto">{b.title || t('Untitled')}</span>
            </button>
          ))}
        </section>
      )}

      <BubbleMenu
        editor={editor}
        options={TABLE_OPTS}
        shouldShow={showTable}
      >
        <div className="bubble" dir="rtl">
          <BTN editor={editor} wide label={t('+ Row')} run={(c) => c.addRowAfter()} />
          <BTN editor={editor} wide label={t('+ Column')} run={(c) => c.addColumnAfter()} />
          <BTN editor={editor} wide label={t('− Row')} run={(c) => c.deleteRow()} />
          <BTN editor={editor} wide label={t('− Column')} run={(c) => c.deleteColumn()} />
          <BTN editor={editor} wide label={t('Merge')} run={(c) => c.mergeCells()} />
          <BTN editor={editor} wide label={t('Split')} run={(c) => c.splitCell()} />
          <span className="sep" />
          <BTN editor={editor} wide label={t('Table RTL')} run={(c) => c.setTableDirection('rtl')} />
          <BTN editor={editor} wide label={t('Table LTR')} run={(c) => c.setTableDirection('ltr')} />
          <span className="sep" />
          {[50, 75, 100].map((w) => (
            <BTN key={w} editor={editor} label={`${w}%`} title={t('Table width {w}%', { w })} on={(editor.getAttributes('table').tableWidth ?? 100) === w} run={(c) => c.setTableWidth(w)} />
          ))}
          <span className="sep" />
          {([['left', '⇤', 'Align table left'], ['center', '↔', 'Center table'], ['right', '⇥', 'Align table right']] as const).map(([a, icon, title]) => (
            <BTN key={a} editor={editor} label={icon} title={t(title)} on={editor.getAttributes('table').tableAlign === a} run={(c) => c.setTableAlign(a)} />
          ))}
          <span className="sep" />
          <BTN editor={editor} wide label={t('Delete table')} run={(c) => c.deleteTable()} />
        </div>
      </BubbleMenu>
    </div>
  )
}
