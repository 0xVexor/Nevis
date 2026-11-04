import { Button, FileIcon, Icon, IconButton, Menu, SearchField, type MenuItem as MenuSpec } from './design-system'
import { setPreference } from './preferenceEvents'
import { useEffect, useMemo, useRef, useState } from 'react'
import { repo } from './store'
import type { Page } from './repo'
import { normalizeFa } from './normalize'
import { wordCount } from './meta'
import { PageIcon } from './PageIcon'
import { ago } from './ui'
import { t } from './i18n'

type SortKey = 'name' | 'modified' | 'kind'
interface Clip {
  ids: string[]
  cut: boolean
}

const byOrder = (a: Page, b: Page) => a.sort - b.sort
const folderFirst = (a: Page, b: Page) => Number(b.kind === 'folder') - Number(a.kind === 'folder')

/**
 * A file-manager view of the vault: browse folders, select several items, rename, cut / copy / paste, duplicate, drag into folders,
 * delete (to the trash, with undo) and search. Pages are the files, folders are folders.
 */
export function Explorer({ pages, onOpen, onChange, onToast }: { pages: Page[]; onOpen: (id: string) => void; onChange: () => void; onToast: (msg: string, undo?: () => void) => void }) {
  const [cwd, setCwd] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [clip, setClip] = useState<Clip | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [mode, setMode] = useState<'list' | 'grid'>(() => (localStorage.getItem('not.explorer.mode') === 'grid' ? 'grid' : 'list'))
  const [menu, setMenu] = useState<{ rect: DOMRect; id: string | null } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [hist, setHist] = useState<{ back: (string | null)[]; fwd: (string | null)[] }>({ back: [], fwd: [] })
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const banded = useRef(false)

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  // a folder that no longer exists (deleted elsewhere) falls back to the top level
  useEffect(() => {
    if (cwd && !byId.has(cwd)) setCwd(null)
  }, [cwd, byId])
  useEffect(() => setPreference('not.explorer.mode', mode), [mode])

  const kids = (id: string | null) => pages.filter((p) => p.parentId === id)
  const path = useMemo(() => {
    const out: Page[] = []
    for (let p = cwd ? byId.get(cwd) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) out.unshift(p)
    return out
  }, [cwd, byId])
  const pathOf = (p: Page) => {
    const parts: string[] = []
    for (let x = p.parentId ? byId.get(p.parentId) : undefined; x; x = x.parentId ? byId.get(x.parentId) : undefined) parts.unshift(x.title || t('Untitled'))
    return '/' + parts.join('/')
  }
  const isInside = (id: string, ancestor: string) => {
    for (let p = byId.get(id); p; p = p.parentId ? byId.get(p.parentId) : undefined) if (p.id === ancestor) return true
    return false
  }

  const nq = normalizeFa(q).trim()
  const items = useMemo(() => {
    const list = nq ? pages.filter((p) => normalizeFa(p.title).includes(nq)) : kids(cwd)
    const cmp = (a: Page, b: Page) => {
      const d =
        sort.key === 'modified'
          ? a.updatedAt - b.updatedAt
          : sort.key === 'kind'
            ? Number(a.kind === 'folder') - Number(b.kind === 'folder')
            : (a.title || t('Untitled')).localeCompare(b.title || t('Untitled'), undefined, { numeric: true, sensitivity: 'base' })
      return d * sort.dir
    }
    return [...list].sort((a, b) => folderFirst(a, b) || (sort.key === 'name' && !nq && sort.dir === 1 ? byOrder(a, b) : cmp(a, b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, cwd, nq, sort])

  const go = (to: string | null, record = true) => {
    if (to === cwd) return
    if (record) setHist((h) => ({ back: [...h.back, cwd], fwd: [] }))
    setCwd(to)
    setSel(new Set())
    setAnchor(null)
    setRenaming(null)
    setQ('')
  }
  const back = () => hist.back.length && (setHist((h) => ({ back: h.back.slice(0, -1), fwd: [cwd, ...h.fwd] })), setCwd(hist.back[hist.back.length - 1]), setSel(new Set()))
  const forward = () => hist.fwd.length && (setHist((h) => ({ back: [...h.back, cwd], fwd: h.fwd.slice(1) })), setCwd(hist.fwd[0]), setSel(new Set()))
  const up = () => go(path.length ? (path[path.length - 1].parentId ?? null) : null)

  const subCount = (p: Page) => (p.kind === 'folder' ? 0 : kids(p.id).length) // pages can hold subpages too
  // folders and pages with subpages are entered; a page with subpages is opened itself with Ctrl (double-click / Enter) or from the menu
  const open = (p: Page, asPage = false) => (p.kind === 'folder' || (subCount(p) && !asPage) ? go(p.id) : onOpen(p.id))
  const targets = () => items.filter((p) => sel.has(p.id))

  // the mouse's side buttons (back / forward) and Alt+←/→ move through the folders you visited, like a file manager
  const nav = useRef({ back, forward })
  nav.current = { back, forward }
  useEffect(() => {
    const stop = (e: MouseEvent) => (e.button === 3 || e.button === 4) && (e.preventDefault(), e.stopPropagation())
    const up = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      e.button === 3 ? nav.current.back() : nav.current.forward()
    }
    window.addEventListener('mousedown', stop, true)
    window.addEventListener('mouseup', up, true)
    window.addEventListener('auxclick', stop, true)
    return () => {
      window.removeEventListener('mousedown', stop, true)
      window.removeEventListener('mouseup', up, true)
      window.removeEventListener('auxclick', stop, true)
    }
  }, [])

  // ───── selection ─────
  const pick = (e: React.MouseEvent, p: Page) => {
    e.stopPropagation()
    if (e.shiftKey && anchor) {
      const a = items.findIndex((x) => x.id === anchor)
      const b = items.findIndex((x) => x.id === p.id)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSel(new Set(items.slice(from, to + 1).map((x) => x.id)))
    } else if ((e.ctrlKey || e.metaKey) && subCount(p)) {
      open(p, true) // Ctrl+click on a page with subpages opens the page itself (a plain double-click enters it)
    } else if (e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s)
        n.has(p.id) ? n.delete(p.id) : n.add(p.id)
        return n
      })
      setAnchor(p.id)
    } else {
      setSel(new Set([p.id]))
      setAnchor(p.id)
    }
    box.current?.focus()
  }

  const allSelected = items.length > 0 && items.every((p) => sel.has(p.id))
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(items.map((p) => p.id)))
  const toggleOne = (e: React.MouseEvent, p: Page) => {
    e.stopPropagation()
    setSel((s) => {
      const n = new Set(s)
      n.has(p.id) ? n.delete(p.id) : n.add(p.id)
      return n
    })
    setAnchor(p.id)
    box.current?.focus()
  }

  // drag a rectangle over empty space to select what it touches (Ctrl keeps the current selection)
  const startBand = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.fx-item, .fx-empty')) return
    const keep = e.ctrlKey || e.metaKey ? new Set(sel) : new Set<string>()
    const x0 = e.clientX
    const y0 = e.clientY
    let moved = false
    const move = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      moved = true
      const r = { x1: Math.min(x0, ev.clientX), y1: Math.min(y0, ev.clientY), x2: Math.max(x0, ev.clientX), y2: Math.max(y0, ev.clientY) }
      setBand(r)
      const hit = new Set(keep)
      body.current?.querySelectorAll<HTMLElement>('.fx-item').forEach((el) => {
        const b = el.getBoundingClientRect()
        if (b.right >= r.x1 && b.left <= r.x2 && b.bottom >= r.y1 && b.top <= r.y2) hit.add(el.dataset.id!)
      })
      setSel(hit)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setBand(null)
      if (moved) banded.current = true // the click that follows must not clear what was just selected
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ───── operations ─────
  const startRename = (id: string) => {
    const p = byId.get(id)
    if (!p) return
    setRenaming(id)
    setDraft(p.title)
  }
  const commitRename = () => {
    if (renaming) {
      repo.update(renaming, { title: draft.trim() })
      onChange()
    }
    setRenaming(null)
  }
  const create = (kind: 'page' | 'folder') => {
    const p = repo.create(cwd, kind === 'folder' ? 'folder' : undefined)
    if (kind === 'folder') repo.update(p.id, { title: t('New folder') })
    onChange()
    setSel(new Set([p.id]))
    setAnchor(p.id)
    setRenaming(p.id)
    setDraft(kind === 'folder' ? t('New folder') : '')
  }
  const remove = (ids: string[]) => {
    if (!ids.length) return
    ids.forEach((id) => repo.remove(id))
    onChange()
    setSel(new Set())
    onToast(
      ids.length === 1 ? t('“{title}” moved to trash', { title: byId.get(ids[0])?.title || t('Untitled') }) : t('{n} items moved to trash', { n: ids.length }),
      () => (ids.forEach((id) => repo.restoreFromTrash(id)), onChange()),
    )
  }
  const copyTree = (id: string, parent: string | null, top: boolean): string => {
    const p = byId.get(id)!
    const c = repo.create(parent, p.kind)
    repo.update(
      c.id,
      {
        title: top && p.title ? p.title + ' ' + t('(copy)') : p.title,
        icon: p.icon,
        cover: p.cover,
        titleDir: p.titleDir,
        tags: p.tags ? [...p.tags] : undefined,
        status: p.status,
        content: structuredClone(p.content),
      },
      { copyContent: true },
    )
    for (const k of kids(id).sort(byOrder)) copyTree(k.id, c.id, false)
    return c.id
  }
  const moveInto = (ids: string[], parent: string | null) => {
    let n = 0
    for (const id of ids) {
      if (id === parent || (parent && isInside(parent, id))) continue // not into itself or its own subfolder
      if (byId.get(id)?.parentId === parent) continue
      if (repo.move(id, parent, null)) n++
    }
    if (n) onChange()
    return n
  }
  const paste = () => {
    if (!clip) return
    if (clip.cut) {
      const n = moveInto(clip.ids, cwd)
      setClip(null)
      if (n) onToast(t('{n} items moved', { n }))
    } else {
      const made = clip.ids.filter((id) => byId.has(id)).map((id) => copyTree(id, cwd, true))
      onChange()
      setSel(new Set(made))
      onToast(t('{n} items pasted', { n: made.length }))
    }
  }
  const duplicate = (ids: string[]) => {
    const made = ids.map((id) => copyTree(id, byId.get(id)!.parentId, true))
    onChange()
    setSel(new Set(made))
  }
  const doCopy = (ids: string[]) => ids.length && (setClip({ ids, cut: false }), onToast(t('{n} items copied', { n: ids.length })))
  const doCut = (ids: string[]) => ids.length && setClip({ ids, cut: true })

  // ───── keyboard ─────
  const onKey = (e: React.KeyboardEvent) => {
    if (renaming || (e.target as HTMLElement).tagName === 'INPUT') return
    const mod = e.ctrlKey || e.metaKey
    const ids = [...sel]
    const idx = items.findIndex((p) => p.id === (anchor ?? ids[0]))
    if (e.key === 'Delete') (e.preventDefault(), remove(ids))
    else if (e.key === 'F2' && ids.length === 1) (e.preventDefault(), startRename(ids[0]))
    else if (e.key === 'Enter' && ids.length === 1) (e.preventDefault(), open(byId.get(ids[0])!, mod))
    else if (e.altKey && e.key === 'ArrowLeft') (e.preventDefault(), back())
    else if (e.altKey && e.key === 'ArrowRight') (e.preventDefault(), forward())
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) (e.preventDefault(), up())
    else if (mod && e.key.toLowerCase() === 'a') (e.preventDefault(), setSel(new Set(items.map((p) => p.id))))
    else if (mod && e.key.toLowerCase() === 'c') (e.preventDefault(), doCopy(ids))
    else if (mod && e.key.toLowerCase() === 'x') (e.preventDefault(), doCut(ids))
    else if (mod && e.key.toLowerCase() === 'v') (e.preventDefault(), paste())
    else if (mod && e.key.toLowerCase() === 'd') (e.preventDefault(), duplicate(ids))
    else if (e.key === 'Escape') setSel(new Set())
    else if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key) && items.length) {
      e.preventDefault()
      const step = mode === 'grid' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') ? 5 : 1
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const next = items[Math.min(items.length - 1, Math.max(0, (idx < 0 ? (dir > 0 ? -1 : items.length) : idx) + dir * step))]
      if (e.shiftKey && anchor) setSel(new Set(items.slice(Math.min(idx, items.indexOf(next)), Math.max(idx, items.indexOf(next)) + 1).map((p) => p.id)))
      else (setSel(new Set([next.id])), setAnchor(next.id))
    }
  }

  // ───── drag & drop ─────
  const dragStart = (e: React.DragEvent, p: Page) => {
    const ids = sel.has(p.id) ? [...sel] : [p.id]
    if (!sel.has(p.id)) setSel(new Set([p.id]))
    e.dataTransfer.setData('application/x-explorer', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'move'
  }
  const dropTo = (e: React.DragEvent, parent: string | null) => {
    setDropOn(null)
    const raw = e.dataTransfer.getData('application/x-explorer')
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    const n = moveInto(JSON.parse(raw) as string[], parent)
    if (n) onToast(t('{n} items moved', { n }))
  }
  const dragOver = (e: React.DragEvent, id: string | null) => {
    if (!e.dataTransfer.types.includes('application/x-explorer')) return
    e.preventDefault()
    e.stopPropagation()
    setDropOn(id ?? '__cwd')
  }

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const kindOf = (p: Page) => (p.kind === 'folder' ? t('Folder') : p.kind === 'board' ? t('Board') : p.kind === 'todo' ? t('To-do list') : t('Page'))
  const metaOf = (p: Page) => (p.kind === 'folder' ? t('{n} items', { n: kids(p.id).length }) : p.kind === 'board' ? t('Drawing') : t('{n} words', { n: wordCount(p.content) }))

  const cell = (p: Page) =>
    renaming === p.id ? (
      <input
        className="fx-rename"
        autoFocus
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commitRename}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commitRename()
          else if (e.key === 'Escape') setRenaming(null)
        }}
      />
    ) : (
      <span className="fx-name">
        <span className="fx-t">{p.title || t('Untitled')}</span>
        {subCount(p) > 0 && (
          <span className="fx-subs" title={t('{n} subpages', { n: subCount(p) })}>
            <Icon name="folder" size={12} />
            {subCount(p)}
          </span>
        )}
      </span>
    )

  const row = (p: Page) => {
    const folder = p.kind === 'folder'
    const holder = folder || subCount(p) > 0 // folders and pages with subpages accept drops
    const cls = 'fx-item' + (sel.has(p.id) ? ' sel' : '') + (clip?.cut && clip.ids.includes(p.id) ? ' cut' : '') + (dropOn === p.id ? ' drop' : '')
    return (
      <div
        key={p.id}
        data-id={p.id}
        className={cls}
        draggable={renaming !== p.id}
        onClick={(e) => pick(e, p)}
        onDoubleClick={() => open(p)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!sel.has(p.id)) setSel(new Set([p.id]))
          setMenu({ rect: new DOMRect(e.clientX, e.clientY, 0, 0), id: p.id })
        }}
        onDragStart={(e) => dragStart(e, p)}
        onDragOver={holder ? (e) => dragOver(e, p.id) : undefined}
        onDragLeave={() => dropOn === p.id && setDropOn(null)}
        onDrop={holder ? (e) => dropTo(e, p.id) : undefined}
      >
        <button
          type="button"
          className={'fx-check' + (sel.has(p.id) ? ' on' : '')}
          role="checkbox"
          aria-checked={sel.has(p.id)}
          aria-label={t('Select')}
          onClick={(e) => toggleOne(e, p)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="check" size={14} />
        </button>
        <span className={'fx-ic' + (folder ? ' folder' : '')}>{folder ? <FileIcon kind="folder" size={mode === 'grid' ? 44 : 26} /> : <PageIcon page={p} />}</span>
        {cell(p)}
        {mode === 'list' && (
          <>
            <span className="fx-col kind">{kindOf(p)}</span>
            <span className="fx-col meta">{metaOf(p)}</span>
            <span className="fx-col when">{nq ? pathOf(p) : ago(p.updatedAt)}</span>
          </>
        )}
        {mode === 'grid' && <small className="fx-sub">{metaOf(p)}</small>}
      </div>
    )
  }

  const menuTarget = menu?.id ? byId.get(menu.id) : undefined
  const ids = [...sel]
  const targetIds = () => targets().map((p) => p.id)
  /** The context menu, built when it opens: for a page or folder, or for the empty area. */
  const buildMenu = (): MenuSpec[] => {
    const items: MenuSpec[] = []
    if (menuTarget) {
      if (subCount(menuTarget) > 0) {
        items.push({ label: 'Show subpages', icon: <Icon name="folder" />, hint: 'Enter', onSelect: () => go(menuTarget.id) })
        items.push({ label: 'Open page', icon: <Icon name="file" />, hint: 'Ctrl Enter', onSelect: () => open(menuTarget, true) })
      } else items.push({ label: 'Open', icon: <Icon name="file" />, hint: 'Enter', onSelect: () => open(menuTarget) })
      items.push({ label: 'Rename', icon: <Icon name="pencil" />, hint: 'F2', onSelect: () => startRename(menuTarget.id) }, { kind: 'sep' })
      items.push({ label: 'Cut', icon: <Icon name="scissors" />, hint: 'Ctrl X', onSelect: () => doCut(targetIds()) })
      items.push({ label: 'Copy', icon: <Icon name="copy" />, hint: 'Ctrl C', onSelect: () => doCopy(targetIds()) })
    }
    items.push({ label: 'Paste', icon: <Icon name="clipboard" />, hint: 'Ctrl V', disabled: !clip, onSelect: paste })
    if (menuTarget) items.push({ label: 'Duplicate', icon: <Icon name="copy" />, hint: 'Ctrl D', onSelect: () => duplicate(targetIds()) })
    items.push({ kind: 'sep' }, { label: 'New page', icon: <Icon name="plus" />, onSelect: () => create('page') }, { label: 'New folder', icon: <Icon name="folder" />, onSelect: () => create('folder') })
    if (menuTarget) items.push({ kind: 'sep' }, { label: 'Delete', icon: <Icon name="trash" />, danger: true, hint: 'Del', onSelect: () => remove(targetIds()) })
    return items
  }
  return (
    <div className="fx" ref={box} tabIndex={0} onKeyDown={onKey}>
      <header className="fx-bar">
        <div className="fx-nav">
          <IconButton label={t('Back')} disabled={!hist.back.length} onClick={back}>
            <Icon name="chevron-left" className="ds-flip" />
          </IconButton>
          <IconButton label={t('Forward')} disabled={!hist.fwd.length} onClick={forward}>
            <Icon name="chevron-right" className="ds-flip" />
          </IconButton>
          <IconButton label={t('Up one level  Backspace')} disabled={!cwd} onClick={up}>
            <Icon name="arrow-up" />
          </IconButton>
        </div>
        <nav className="fx-path" aria-label={t('Path')}>
          <button
            className={'fx-seg' + (dropOn === '__root' ? ' drop' : '')}
            onClick={() => go(null)}
            onDragOver={(e) => (dragOver(e, null), setDropOn('__root'))}
            onDragLeave={() => setDropOn(null)}
            onDrop={(e) => dropTo(e, null)}
          >
            <Icon name="vault" size={16} />
            {t('Vault')}
          </button>
          {path.map((p) => (
            <span key={p.id} className="fx-crumb">
              <span className="fx-sep">
                <Icon name="chevron-right" size={14} className="ds-flip" />
              </span>
              <button
                className={'fx-seg' + (dropOn === 'p' + p.id ? ' drop' : '')}
                onClick={() => go(p.id)}
                onDragOver={(e) => (dragOver(e, p.id), setDropOn('p' + p.id))}
                onDragLeave={() => setDropOn(null)}
                onDrop={(e) => dropTo(e, p.id)}
                dir="auto"
              >
                {p.title || t('Untitled')}
              </button>
            </span>
          ))}
        </nav>
        <SearchField className="fx-search" value={q} onChange={setQ} label={t('Search in all folders…')} placeholder={t('Search in all folders…')} clearLabel={t('Clear')} />
        <div className="ds-seg" role="group" aria-label={t('View')}>
          <button type="button" aria-pressed={mode === 'list'} title={t('List')} onClick={() => setMode('list')}>
            <Icon name="list" size={16} />
          </button>
          <button type="button" aria-pressed={mode === 'grid'} title={t('Icons')} onClick={() => setMode('grid')}>
            <Icon name="gallery" size={16} />
          </button>
        </div>
      </header>

      <div className="fx-actions">
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={16} />} onClick={() => create('page')}>
          {t('New page')}
        </Button>
        <Button size="sm" icon={<Icon name="folder" size={16} />} onClick={() => create('folder')}>
          {t('New folder')}
        </Button>
        <span className="fx-div" />
        <Button variant="ghost" size="sm" icon={<Icon name="check" size={16} />} disabled={!items.length} onClick={toggleAll}>
          {allSelected ? t('Deselect all') : t('Select all')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="scissors" size={16} />} disabled={!ids.length} onClick={() => doCut(ids)}>
          {t('Cut')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="copy" size={16} />} disabled={!ids.length} onClick={() => doCopy(ids)}>
          {t('Copy')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="clipboard" size={16} />} disabled={!clip} onClick={paste}>
          {t('Paste')}
          {clip && <span className="ds-badge">{clip.ids.length}</span>}
        </Button>
        <span className="fx-div" />
        <Button variant="ghost" size="sm" icon={<Icon name="pencil" size={16} />} disabled={ids.length !== 1} onClick={() => startRename(ids[0])}>
          {t('Rename')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="copy" size={16} />} disabled={!ids.length} onClick={() => duplicate(ids)}>
          {t('Duplicate')}
        </Button>
        <Button variant="danger" size="sm" icon={<Icon name="trash" size={16} />} disabled={!ids.length} onClick={() => remove(ids)}>
          {t('Delete')}
        </Button>
      </div>

      {mode === 'list' && (
        <div className="fx-head">
          <button type="button" className={'fx-check' + (allSelected ? ' on' : sel.size ? ' some' : '')} role="checkbox" aria-checked={allSelected} aria-label={t('Select all')} onClick={toggleAll}>
            <Icon name="check" size={14} />
          </button>
          <button className="fx-h name" onClick={() => sortBy('name')}>
            {t('Name')}
            {sort.key === 'name' && (
              <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}>
                <Icon name="chevron-down" size={12} />
              </span>
            )}
          </button>
          <button className="fx-h kind" onClick={() => sortBy('kind')}>
            {t('Type')}
            {sort.key === 'kind' && (
              <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}>
                <Icon name="chevron-down" size={12} />
              </span>
            )}
          </button>
          <span className="fx-h meta">{t('Size')}</span>
          <button className="fx-h when" onClick={() => sortBy('modified')}>
            {nq ? t('Location') : t('Modified')}
            {sort.key === 'modified' && (
              <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}>
                <Icon name="chevron-down" size={12} />
              </span>
            )}
          </button>
        </div>
      )}

      <div
        ref={body}
        className={'fx-body ' + mode + (dropOn === '__cwd' ? ' drop' : '')}
        onMouseDown={startBand}
        onClick={(e) => {
          if (banded.current) banded.current = false
          else if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.fx-empty')) setSel(new Set())
          box.current?.focus()
        }}
        onContextMenu={(e) => (e.preventDefault(), setSel(new Set()), setMenu({ rect: new DOMRect(e.clientX, e.clientY, 0, 0), id: null }))}
        onDragOver={(e) => dragOver(e, null)}
        onDragLeave={() => setDropOn(null)}
        onDrop={(e) => dropTo(e, cwd)}
      >
        {items.map(row)}
        {items.length === 0 && (
          <div className="ds-empty fx-empty">
            <Icon name="folder" size={28} />
            <b>{nq ? t('No results found') : t('This folder is empty')}</b>
            {!nq && <small>{t('Create a page or folder, or drag items here.')}</small>}
          </div>
        )}
      </div>

      {band && <div className="fx-rubber" style={{ left: band.x1, top: band.y1, width: band.x2 - band.x1, height: band.y2 - band.y1 }} />}

      <footer className="fx-status">
        <span>{t('{n} items', { n: items.length })}</span>
        {sel.size > 0 && <span>{t('{n} selected', { n: sel.size })}</span>}
        {clip && <span className="fx-clip">{clip.cut ? t('{n} items ready to move', { n: clip.ids.length }) : t('{n} items copied', { n: clip.ids.length })}</span>}
        <span className="fx-hint">{t('Del delete · F2 rename · Ctrl+C/X/V · drag to move')}</span>
      </footer>

      {menu && <Menu anchor={menu.rect} items={buildMenu()} onClose={() => setMenu(null)} />}
    </div>
  )
}
