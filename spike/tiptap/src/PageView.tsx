import { shortcutLabel } from './shortcuts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { registerUpdateSave } from './updateSave'
import { createPortal } from 'react-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import { getSchema } from '@tiptap/core'
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state'
import { addVersion } from './db'
import { LayoutControls } from './LayoutControls'
import { contentProblem } from './editor/contentSafety'
import { LAYOUT_CANCEL } from './editor/layout'
import { activeGroup, validWidths } from './editor/layoutModel'
import { getFind, scrollToMatch } from './editor/find'
import { looksLikeMermaid } from './editor/mermaid'
import { TableBubble } from './TableBubble'
import { PageLinkPicker } from './PageLinkPicker'
import { ImageBubble } from './ImageBubble'
import { extensions } from './editor/extensions'
import { repo } from './store'
import type { Page, PageStatus } from './repo'
import { STATUS, addTag, allTags } from './meta'
import { History } from './History'
import { normalizeFa } from './normalize'
import { getTemplates, type Template } from './templates'
import { OPEN_PAGE, PAGES_CHANGED } from './editor/pageLink'
import { ago, EmojiPicker, MenuItem, MenuLabel, MenuSep, Popover, Select } from './ui'
import { printPage } from './print'
import { toneOf } from './PageIcon'
import { Glyph, isGlyph, parseIcon } from './iconSet'
import { TEMPLATE_GLYPH } from './TemplateGallery'
import { iconNode } from './iconSet'
import * as Ic from './icons'
import { Toolbar } from './Toolbar'
import { t } from './i18n'
import { lazy, Suspense } from 'react'
const RowProperties = lazy(() => import('./database/ui/RowProperties').then((m) => ({ default: m.RowProperties })))

export type SaveState = 'saved' | 'saving'

const TITLE_CMDS = [
  { id: 'rtl', title: 'Right-to-left (RTL)', desc: 'Make the title right-to-left', kw: 'rtl direction right to left جهت راست چین' },
  { id: 'ltr', title: 'Left-to-right (LTR)', desc: 'Make the title left-to-right', kw: 'ltr direction left to right جهت چپ چین' },
  { id: 'auto', title: 'Auto direction', desc: 'Detect direction from the text', kw: 'auto direction خودکار جهت' },
]

export function PageView({ page, onSave, onMeta, onCover, readOnly: readerOnly = false }: { page: Page; onSave: (s: SaveState) => void; onMeta: () => void; onCover: (anchor: DOMRect) => void; readOnly?: boolean }) {
  const schema = useMemo(() => getSchema(extensions), [])
  const [contentIssue, setContentIssue] = useState(() => contentProblem(page.content, schema))
  const protectedContent = useRef(!!contentIssue)
  const [originalContent, setOriginalContent] = useState(page.content)
  const dirty = useRef(false)
  const readOnly = readerOnly || !!contentIssue
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
    if (ed && !ed.isDestroyed && dirty.current && !protectedContent.current) {
      const content = ed.getJSON()
      if (JSON.stringify(repo.get(page.id)?.content) !== JSON.stringify(content)) repo.update(page.id, { content })
      dirty.current = false
      onSave('saved')
    }
  }, [page.id, onSave])

  useEffect(() => registerUpdateSave(flush), [flush])

  const editor = useEditor(
    {
      extensions,
      content: contentIssue ? { type: 'doc', content: [{ type: 'paragraph' }] } : page.content,
      editable: !readOnly,
      shouldRerenderOnTransaction: true,
      editorProps: { attributes: { spellcheck: 'false' } },
      onUpdate: () => {
        if (protectedContent.current) return
        dirty.current = true
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
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false)
  }, [editor, readOnly])
  // the page picker (`[[`, `@`) must not offer the page you are on
  useEffect(() => {
    if (editor) (editor.storage as any).currentPageId = page.id
  }, [editor, page.id])

  // right-click inside the text: clipboard and undo actions (the browser's own menu is switched off in the desktop app)
  const [ctx, setCtx] = useState<DOMRect | null>(null)
  // plain $…$ text becomes a formula once the editor loses focus (it already does when the cursor leaves the paragraph)
  useEffect(() => {
    if (!editor) return
    const onBlur = () => !editor.isDestroyed && editor.isEditable && (editor.commands as any).convertFormulas()
    editor.on('blur', onBlur)
    return () => void editor.off('blur', onBlur)
  }, [editor])
  const [addingTag, setAddingTag] = useState(false)
  const [linkPick, setLinkPick] = useState<{ rect: DOMRect; from: number; to: number; text: string } | null>(null)
  useEffect(() => {
    if (!editor) return
    // "Link to page" with text selected: pick the page the selection should point to
    const open = (e: Event) => {
      const { from, to } = (e as CustomEvent<{ from: number; to: number }>).detail
      const c = editor.view.coordsAtPos(to)
      setLinkPick({ rect: new DOMRect(c.left, c.top, 0, c.bottom - c.top), from, to, text: editor.state.doc.textBetween(from, to, ' ') })
    }
    window.addEventListener('pick-page-link', open)
    return () => window.removeEventListener('pick-page-link', open)
  }, [editor])
  const [iconAt, setIconAt] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!editor) return
    // "/" > Icon: the slash text is already removed; open the picker where the caret is
    const open = () => window.setTimeout(() => {
      const c = editor.view.coordsAtPos(editor.state.selection.from)
      setIconAt(new DOMRect(c.left, c.top, 0, c.bottom - c.top))
    }, 0)
    window.addEventListener('pick-inline-icon', open)
    return () => window.removeEventListener('pick-inline-icon', open)
  }, [editor])
  const [tagDraft, setTagDraft] = useState('')
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const dom = editor.view.dom
    const open = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      e.preventDefault()
      setCtx(new DOMRect(e.clientX, e.clientY, 0, 0))
    }
    dom.addEventListener('contextmenu', open)
    return () => dom.removeEventListener('contextmenu', open)
  }, [editor])
  const paste = async (plain: boolean) => {
    if (!editor) return
    editor.commands.focus()
    try {
      const items = plain ? [] : await navigator.clipboard.read()
      for (const it of items) {
        if (it.types.includes('text/html')) return editor.view.pasteHTML(await (await it.getType('text/html')).text())
      }
      editor.view.pasteText(await navigator.clipboard.readText())
    } catch {
      /* clipboard access denied */
    }
  }
  const hasSel = !!editor && !editor.state.selection.empty

  // outline: which heading is the reader at (last one that has scrolled past the top of the page area)
  const [activeHead, setActiveHead] = useState(-1)
  useEffect(() => {
    if (!editor) return
    const sc = document.querySelector('.scroller')
    if (!sc) return
    const on = () => {
      if (editor.isDestroyed) return
      const r = sc.getBoundingClientRect()
      const top = r.top + Math.max(140, r.height * 0.35)
      let cur = -1
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name !== 'heading') return true
        const el = editor.view.nodeDOM(pos) as HTMLElement | null
        if (el && el.getBoundingClientRect().top <= top) cur = pos
        return false
      })
      setActiveHead(cur)
    }
    on()
    sc.addEventListener('scroll', on, { passive: true })
    editor.on('update', on)
    return () => {
      sc.removeEventListener('scroll', on)
      editor.off('update', on)
    }
  }, [editor])

  // another device changed this page (arrived through the synced vault folder): show its content without saving it back
  useEffect(() => {
    const onExternal = (e: Event) => {
      if (!editor || editor.isDestroyed || !(e as CustomEvent<string[]>).detail.includes(page.id)) return
      const fresh = repo.get(page.id)?.content
      if (!fresh || typeof fresh === 'string') return
      const issue = contentProblem(fresh, schema)
      const doc = issue ? null : editor.schema.nodeFromJSON(fresh)
      // A disk acknowledgement can reorder JSON keys without changing the document.
      if (doc?.eq(editor.state.doc) && !protectedContent.current) return
      editor.view.dom.dispatchEvent(new Event(LAYOUT_CANCEL))
      window.clearTimeout(timer.current)
      if (dirty.current && !protectedContent.current) {
        void addVersion({ pageId: page.id, ts: Date.now(), title: page.title, content: editor.getJSON() })
        window.dispatchEvent(new Event('sync-conflict'))
      }
      dirty.current = false
      onSave('saved')
      setOriginalContent(fresh)
      protectedContent.current = !!issue
      setContentIssue(issue)
      editor.setEditable(!readerOnly && !issue, false)
      if (doc) {
        // Clear stale undo history while retaining a valid caret and scroll position.
        const previous = editor.state.selection
        const at = (pos: number) => doc.resolve(Math.min(pos, doc.content.size))
        const selection = previous instanceof TextSelection
          ? TextSelection.between(at(previous.anchor), at(previous.head))
          : Selection.near(at(previous.head))
        const scroller = editor.view.dom.closest<HTMLElement>('.scroller')
        const top = scroller?.scrollTop, left = scroller?.scrollLeft
        editor.view.updateState(EditorState.create({ schema: editor.schema, doc, selection, plugins: editor.state.plugins }))
        if (scroller) { scroller.scrollTop = top!; scroller.scrollLeft = left! }
      }
    }
    window.addEventListener('external-change', onExternal)
    return () => window.removeEventListener('external-change', onExternal)
  }, [editor, page.id, page.title, readerOnly, schema, onSave])

  useEffect(() => {
    if (editor && !protectedContent.current && typeof page.content === 'string') repo.update(page.id, { content: editor.getJSON() })
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

  // a page created from the Templates gallery: fill it once its editor exists
  useEffect(() => {
    const p = (window as any).__pendingTpl
    if (!editor || !p || p.pageId !== page.id) return
    delete (window as any).__pendingTpl
    const tp = getTemplates().find((x) => x.id === p.id)
    if (!tp) return
    editor.commands.setContent(tp.html)
    onMeta()
    requestAnimationFrame(() => {
      const el = titleRef.current
      if (!el) return
      el.value = tp.pageTitle
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [editor, page.id])

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
    if (!icon) {
      const g = 'i:' + (TEMPLATE_GLYPH[t.id] ?? 'page')
      repo.update(page.id, { icon: g })
      setIcon(g)
    }
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
          <button title={t('Previous  Shift+Enter')} onClick={() => stepFind(-1)}><span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}><Ic.Chevron size={14} /></span></button>
          <button title={t('Next  Enter')} onClick={() => stepFind(1)}><span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><Ic.Chevron size={14} /></span></button>
          <button title={t('Close  Esc')} onClick={closeFind}><Ic.Close size={14} /></button>
        </div>
      )}
      {slot &&
        createPortal(
          <section>
            <h4>{t('Outline')}</h4>
            {heads.length === 0 && <div className="pd-note">{t('Add headings (H1–H3) and the outline will appear here.')}</div>}
            {heads.length > 0 && (
              <nav className="ol-tl">
                {heads.map((h) => (
                  <button key={h.pos} className={'ol-item' + (h.pos === activeHead ? ' on' : '')} style={{ ['--lv' as string]: h.level - 1 } as React.CSSProperties} onClick={() => gotoHeading(h.pos)}>
                    <i className="ol-dot" />
                    <span className="ol-tx" dir="auto">{h.text || t('Untitled')}</span>
                  </button>
                ))}
              </nav>
            )}
          </section>,
          slot,
        )}
      <div className="page-head">
        <div className="page-top">
          <button className={'page-icon' + (icon ? '' : ' empty')} onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} title={t('Change icon')}>
            {icon ? <span className="page-icon-g" style={isGlyph(icon) ? { color: parseIcon(icon).color ?? toneOf(page.id) } : undefined}>{iconNode(icon, 40)}</span> : <Ic.Page size={44} />}
          </button>
          <div className="page-tools">
            {!icon && <button onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}><Ic.Star size={14} />{t('Add icon')}</button>}
            {!page.cover && <button onClick={(e) => onCover(e.currentTarget.getBoundingClientRect())}><Ic.Image size={14} />{t('Add cover')}</button>}
          </div>
        </div>
        {picker && (
          <Popover anchor={picker} onClose={() => setPicker(null)}>
            <EmojiPicker
              current={icon}
              onPick={(e, close = true) => (repo.update(page.id, { icon: e }), setIcon(e), close && setPicker(null), onMeta())}
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

      {page.database && <Suspense fallback={null}><RowProperties pageId={page.id} /></Suspense>}
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
            <button title={t('Remove')} onClick={() => saveTags(tags.filter((x) => x !== tag))}><Ic.Close size={11} /></button>
          </span>
        ))}
        {addingTag ? (
          <span className="tag-new">
            <span className="tag-new-h">#</span>
            <input
              className="tag-input"
              dir="auto"
              autoFocus
              value={tagDraft}
              placeholder={t('Tag name…')}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',' || e.key === '،') && tagDraft.trim()) {
                  e.preventDefault()
                  saveTags(addTag(tags, tagDraft))
                  setTagDraft('')
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setTagDraft('')
                  setAddingTag(false)
                } else if (e.key === 'Backspace' && !tagDraft && tags.length) saveTags(tags.slice(0, -1))
              }}
              onBlur={() => {
                if (tagDraft.trim()) saveTags(addTag(tags, tagDraft))
                setTagDraft('')
                setAddingTag(false)
              }}
            />
            {(() => {
              const q = normalizeFa(tagDraft.trim())
              const sugg = allTags(repo.pagesOnly())
                .filter((x) => !tags.some((y) => normalizeFa(y) === normalizeFa(x)) && (!q || normalizeFa(x).includes(q)))
                .slice(0, 6)
              return (
                sugg.length > 0 && (
                  <div className="tag-sugg" role="listbox">
                    {sugg.map((x) => (
                      <button key={x} type="button" role="option" onMouseDown={(e) => (e.preventDefault(), saveTags(addTag(tags, x)), setTagDraft(''))}>
                        <span className="tagchip-h">#</span>
                        <span dir="auto">{x}</span>
                      </button>
                    ))}
                  </div>
                )
              )
            })()}
          </span>
        ) : (
          <button type="button" className="tag-add" title={t('Add tag…')} aria-label={t('Add tag…')} onClick={() => setAddingTag(true)}>
            <Ic.Plus size={14} />
            {tags.length === 0 && <span>{t('Add tag…')}</span>}
          </button>
        )}
            </div>
          </div>
        </div>
        </div>
        <div className="meta-row inline">
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
              <span className="tpl-chip-ic"><Glyph name={TEMPLATE_GLYPH[t.id] ?? 'page'} size={14} /></span>
              {t.title}
            </button>
          ))}
        </div>
      )}

      {!readOnly && <Toolbar editor={editor} diagram={diagram} />}
      {ctx && editor && (
        <Popover anchor={ctx} onClose={() => setCtx(null)}>
          <div className="menu ctx-menu">
            {!readOnly && (
              <div className="menu-quick">
                <button title={t('Undo') + '  ' + shortcutLabel(['Mod', 'Z'])} onClick={() => (setCtx(null), editor.chain().focus().undo().run())}><Ic.Undo size={16} /></button>
                <button title={t('Redo  Ctrl+Y')} onClick={() => (setCtx(null), editor.chain().focus().redo().run())}><Ic.Redo size={16} /></button>
                {hasSel && <button title={t('Cut') + '  ' + shortcutLabel(['Mod', 'X'])} onClick={() => (setCtx(null), document.execCommand('cut'))}><Ic.Cut size={16} /></button>}
                {hasSel && <button title={t('Copy') + '  ' + shortcutLabel(['Mod', 'C'])} onClick={() => (setCtx(null), document.execCommand('copy'))}><Ic.Copy size={16} /></button>}
                <button title={t('Paste') + '  ' + shortcutLabel(['Mod', 'V'])} onClick={() => (setCtx(null), void paste(false))}><Ic.Paste size={16} /></button>
              </div>
            )}
            {!readOnly && hasSel && (
              <>
                <MenuLabel>{t('Format')}</MenuLabel>
                <MenuItem icon={<Ic.Bold />} label={t('Bold')} hint="Ctrl+B" onClick={() => (setCtx(null), editor.chain().focus().toggleBold().run())} />
                <MenuItem icon={<Ic.Italic />} label={t('Italic')} hint="Ctrl+I" onClick={() => (setCtx(null), editor.chain().focus().toggleItalic().run())} />
                <MenuItem icon={<Ic.Strike />} label={t('Strikethrough')} onClick={() => (setCtx(null), editor.chain().focus().toggleStrike().run())} />
                <MenuItem icon={<Ic.Code />} label={t('Code')} onClick={() => (setCtx(null), editor.chain().focus().toggleCode().run())} />
                <MenuItem icon={<Ic.Quote />} label={t('Quote')} onClick={() => (setCtx(null), editor.chain().focus().toggleBlockquote().run())} />
              </>
            )}
            {!readOnly && <MenuItem icon={<Ic.Arrow />} label={t('Move to Column')} hint="Ctrl+Alt+M" onClick={() => { setCtx(null); editor.view.dom.dispatchEvent(new CustomEvent('layout-move-menu', { detail: ctx })) }} />}
            {!readOnly && <MenuItem icon={<Ic.Paste />} label={t('Paste as plain text')} hint="Ctrl+Shift+V" onClick={() => (setCtx(null), void paste(true))} />}
            {!readOnly && <MenuItem icon={<Ic.Code />} label={t('Convert $…$ to formulas')} onClick={() => (setCtx(null), (editor.commands as any).convertFormulas())} />}
            <MenuItem icon={<Ic.SelectAll />} label={t('Select all')} hint="Ctrl+A" onClick={() => (setCtx(null), editor.chain().focus().selectAll().run())} />
            <MenuSep />
            <MenuItem icon={<Ic.Search />} label={t('Find in page')} hint="Ctrl+F" onClick={() => (setCtx(null), window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })))} />
            <MenuItem icon={<Ic.History />} label={t('History')} onClick={() => (setCtx(null), window.dispatchEvent(new Event('open-history')))} />
            <MenuItem icon={<Ic.Reader />} label={t('Reader mode')} hint="Ctrl ." onClick={() => (setCtx(null), window.dispatchEvent(new Event('toggle-reader')))} />
            <MenuItem icon={<Ic.Print />} label={t('Print / PDF')} onClick={() => (setCtx(null), printPage(page.title))} />
          </div>
        </Popover>
      )}
      {!readOnly && <LayoutControls editor={editor} />}
      {!readOnly && (() => {
        const group = activeGroup(editor.state)
        return group && !validWidths(group.node.attrs.widths, group.node.childCount) ? <p className="layout-width-warning" role="status">{t('Invalid column widths are displayed equally. Choose a width preset to repair this layout.')}</p> : null
      })()}
      {contentIssue ? <div className="layout-protection" role="status">
        <p>{t(contentIssue)}</p>
        <details><summary>{t('View original page data')}</summary><pre>{JSON.stringify(originalContent, null, 2)}</pre></details>
      </div> : <EditorContent editor={editor} className="ec" />}

      {historyOpen && <History page={page} editor={editor} onClose={() => setHistoryOpen(false)} />}

      {backs.length > 0 && (
        <section className="backlinks">
          <div className="backlinks-title">{t('Backlinks')} · {backs.length}</div>
          {backs.map((b) => (
            <button key={b.id} className="backlink" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: b.id }))}>
              <span className="backlink-ic">{iconNode(b.icon, 15, <Ic.Page size={15} />)}</span>
              <span dir="auto">{b.title || t('Untitled')}</span>
            </button>
          ))}
        </section>
      )}

      {linkPick && (
        <Popover anchor={linkPick.rect} onClose={() => (setLinkPick(null), editor.commands.focus())}>
          <PageLinkPicker
            text={linkPick.text}
            currentId={page.id}
            onPick={(id) => {
              const { from, to, text } = linkPick
              let target = id
              if (!target) {
                target = repo.create(null).id
                repo.update(target, { title: text.trim() })
                window.dispatchEvent(new Event(PAGES_CHANGED))
              }
              setLinkPick(null)
              editor.chain().focus().insertContentAt({ from, to }, { type: 'pageLink', attrs: { id: target, label: text.trim() } }).run()
              onMeta()
            }}
          />
        </Popover>
      )}
      {iconAt && (
        <Popover anchor={iconAt} onClose={() => (setIconAt(null), editor.commands.focus())}>
          <EmojiPicker
            onClear={() => (setIconAt(null), editor.commands.focus())}
            onPick={(ic) => {
              const g = parseIcon(ic)
              setIconAt(null)
              editor.chain().focus().insertContent({ type: 'inlineIcon', attrs: { name: g.name, color: g.color ?? null } }).run()
            }}
            clearLabel={t('Cancel')}
          />
        </Popover>
      )}
      <TableBubble editor={editor} />
      <ImageBubble editor={editor} />
    </div>
  )
}
