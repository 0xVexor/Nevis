import { useEffect, useMemo, useRef, useState } from 'react'
import { repo } from './store'
import type { Page } from './repo'
import { normalizeFa } from './normalize'
import { wordCount } from './meta'
import { PageIcon } from './PageIcon'
import { MenuItem, MenuSep, Popover, ago } from './ui'
import * as Ic from './icons'
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
  useEffect(() => localStorage.setItem('not.explorer.mode', mode), [mode])

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
        sort.key === 'modified' ? a.updatedAt - b.updatedAt : sort.key === 'kind' ? Number(a.kind === 'folder') - Number(b.kind === 'folder') : (a.title || t('Untitled')).localeCompare(b.title || t('Untitled'), undefined, { numeric: true, sensitivity: 'base' })
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

  const open = (p: Page) => (p.kind === 'folder' ? go(p.id) : onOpen(p.id))
  const target = () => items.filter((p) => sel.has(p.id))

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
    onToast(ids.length === 1 ? t('“{title}” moved to trash', { title: byId.get(ids[0])?.title || t('Untitled') }) : t('{n} items moved to trash', { n: ids.length }), () => (ids.forEach((id) => repo.restoreFromTrash(id)), onChange()))
  }
  const copyTree = (id: string, parent: string | null, top: boolean): string => {
    const p = byId.get(id)!
    const c = repo.create(parent, p.kind)
    repo.update(c.id, { title: top && p.title ? p.title + ' ' + t('(copy)') : p.title, icon: p.icon, cover: p.cover, titleDir: p.titleDir, tags: p.tags ? [...p.tags] : undefined, status: p.status, content: structuredClone(p.content) })
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
    else if (e.key === 'Enter' && ids.length === 1) (e.preventDefault(), open(byId.get(ids[0])!))
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
  const kindOf = (p: Page) => (p.kind === 'folder' ? t('Folder') : t('Page'))
  const metaOf = (p: Page) => (p.kind === 'folder' ? t('{n} items', { n: kids(p.id).length }) : t('{n} words', { n: wordCount(p.content) }))

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
      <span className="fx-name">{p.title || t('Untitled')}</span>
    )

  const row = (p: Page) => {
    const folder = p.kind === 'folder'
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
        onDragOver={folder ? (e) => dragOver(e, p.id) : undefined}
        onDragLeave={() => dropOn === p.id && setDropOn(null)}
        onDrop={folder ? (e) => dropTo(e, p.id) : undefined}
      >
        <button type="button" className={'fx-check' + (sel.has(p.id) ? ' on' : '')} role="checkbox" aria-checked={sel.has(p.id)} aria-label={t('Select')} onClick={(e) => toggleOne(e, p)} onDoubleClick={(e) => e.stopPropagation()}>
          <Ic.Check size={13} />
        </button>
        <span className={'fx-ic' + (folder ? ' folder' : '')}>{folder ? <Ic.Folder size={mode === 'grid' ? 30 : 18} /> : <PageIcon page={p} />}</span>
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
  return (
    <div className="fx" ref={box} tabIndex={0} onKeyDown={onKey}>
      <header className="fx-bar">
        <div className="fx-nav">
          <button className="icon-btn" title={t('Back')} disabled={!hist.back.length} onClick={back}><span className="fx-flip"><Ic.Chevron size={16} /></span></button>
          <button className="icon-btn" title={t('Forward')} disabled={!hist.fwd.length} onClick={forward}><Ic.Chevron size={16} /></button>
          <button className="icon-btn" title={t('Up one level  Backspace')} disabled={!cwd} onClick={up}><Ic.Up size={16} /></button>
        </div>
        <nav className="fx-path" aria-label={t('Path')}>
          <button className={'fx-seg' + (dropOn === '__root' ? ' drop' : '')} onClick={() => go(null)} onDragOver={(e) => (dragOver(e, null), setDropOn('__root'))} onDragLeave={() => setDropOn(null)} onDrop={(e) => dropTo(e, null)}>
            <Ic.Layers size={14} />{t('Vault')}
          </button>
          {path.map((p) => (
            <span key={p.id} className="fx-crumb">
              <span className="fx-sep"><Ic.Chevron size={12} /></span>
              <button className={'fx-seg' + (dropOn === 'p' + p.id ? ' drop' : '')} onClick={() => go(p.id)} onDragOver={(e) => (dragOver(e, p.id), setDropOn('p' + p.id))} onDragLeave={() => setDropOn(null)} onDrop={(e) => dropTo(e, p.id)} dir="auto">
                {p.title || t('Untitled')}
              </button>
            </span>
          ))}
        </nav>
        <label className="fx-search">
          <Ic.Search size={15} />
          <input value={q} dir="auto" placeholder={t('Search in all folders…')} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="fx-view" role="group" aria-label={t('View')}>
          <button className={mode === 'list' ? 'on' : ''} title={t('List')} onClick={() => setMode('list')}><Ic.List size={16} /></button>
          <button className={mode === 'grid' ? 'on' : ''} title={t('Icons')} onClick={() => setMode('grid')}><Ic.Blocks size={16} /></button>
        </div>
      </header>

      <div className="fx-actions">
        <button onClick={() => create('page')}><Ic.Plus size={15} />{t('New page')}</button>
        <button onClick={() => create('folder')}><Ic.Folders size={15} />{t('New folder')}</button>
        <button disabled={!items.length} onClick={toggleAll}><Ic.Check size={15} />{allSelected ? t('Deselect all') : t('Select all')}</button>
        <span className="fx-div" />
        <button disabled={!ids.length} onClick={() => doCut(ids)}><Ic.Cut size={15} />{t('Cut')}</button>
        <button disabled={!ids.length} onClick={() => doCopy(ids)}><Ic.Copy size={15} />{t('Copy')}</button>
        <button disabled={!clip} onClick={paste}><Ic.Paste size={15} />{t('Paste')}{clip && <em>{clip.ids.length}</em>}</button>
        <span className="fx-div" />
        <button disabled={ids.length !== 1} onClick={() => startRename(ids[0])}><Ic.Pencil size={15} />{t('Rename')}</button>
        <button disabled={!ids.length} onClick={() => duplicate(ids)}><Ic.Copy size={15} />{t('Duplicate')}</button>
        <button className="danger" disabled={!ids.length} onClick={() => remove(ids)}><Ic.Trash size={15} />{t('Delete')}</button>
      </div>

      {mode === 'list' && (
        <div className="fx-head">
          <button type="button" className={'fx-check' + (allSelected ? ' on' : sel.size ? ' some' : '')} role="checkbox" aria-checked={allSelected} aria-label={t('Select all')} onClick={toggleAll}>
            <Ic.Check size={13} />
          </button>
          <button className="fx-h name" onClick={() => sortBy('name')}>{t('Name')}{sort.key === 'name' && <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}><Ic.Chevron size={11} /></span>}</button>
          <button className="fx-h kind" onClick={() => sortBy('kind')}>{t('Type')}{sort.key === 'kind' && <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}><Ic.Chevron size={11} /></span>}</button>
          <span className="fx-h meta">{t('Size')}</span>
          <button className="fx-h when" onClick={() => sortBy('modified')}>{nq ? t('Location') : t('Modified')}{sort.key === 'modified' && <span className={'sort-arrow ' + (sort.dir === 1 ? 'asc' : 'desc')}><Ic.Chevron size={11} /></span>}</button>
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
          <div className="fx-empty">
            <span className="fc2-art"><Ic.Folders size={30} /></span>
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

      {menu && (
        <Popover anchor={menu.rect} onClose={() => setMenu(null)}>
          <div className="menu">
            {menuTarget && <MenuItem icon={<Ic.Open />} label={t('Open')} hint="Enter" onClick={() => (setMenu(null), open(menuTarget))} />}
            {menuTarget && <MenuItem icon={<Ic.Pencil />} label={t('Rename')} hint="F2" onClick={() => (setMenu(null), startRename(menuTarget.id))} />}
            {menuTarget && <MenuSep />}
            {menuTarget && <MenuItem icon={<Ic.Cut />} label={t('Cut')} hint="Ctrl X" onClick={() => (setMenu(null), doCut(target().map((p) => p.id)))} />}
            {menuTarget && <MenuItem icon={<Ic.Copy />} label={t('Copy')} hint="Ctrl C" onClick={() => (setMenu(null), doCopy(target().map((p) => p.id)))} />}
            <MenuItem icon={<Ic.Paste />} label={t('Paste')} hint="Ctrl V" disabled={!clip} onClick={() => (setMenu(null), paste())} />
            {menuTarget && <MenuItem icon={<Ic.Copy />} label={t('Duplicate')} hint="Ctrl D" onClick={() => (setMenu(null), duplicate(target().map((p) => p.id)))} />}
            <MenuSep />
            <MenuItem icon={<Ic.Plus />} label={t('New page')} onClick={() => (setMenu(null), create('page'))} />
            <MenuItem icon={<Ic.Folders />} label={t('New folder')} onClick={() => (setMenu(null), create('folder'))} />
            {menuTarget && <MenuSep />}
            {menuTarget && <MenuItem danger icon={<Ic.Trash />} label={t('Delete')} hint="Del" onClick={() => (setMenu(null), remove(target().map((p) => p.id)))} />}
          </div>
        </Popover>
      )}
    </div>
  )
}
