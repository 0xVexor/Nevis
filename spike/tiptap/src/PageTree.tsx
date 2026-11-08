import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Page } from './repo'
import type { PageIndex } from './pageIndex'
import { PageIcon } from './PageIcon'
import { AnimatePresence, motion } from 'motion/react'
import { cx, dirOf, useUIMotion, Icon } from './design-system'
import { t } from './i18n'

export interface RowProps {
  page: Page
  depth: number
  index: PageIndex
  currentId: string
  /** the selected row (a click, the arrow keys); a double-click or Enter opens it */
  selectedId: string | null
  onSelect: (id: string) => void
  /** the "Open with a single click" option: a click on a page opens it straight away */
  openOnClick: boolean
  collapsed: Set<string>
  onToggle: (id: string) => void
  /** focus: move the keys to the opened page (Enter, a double-click); a single-click open leaves them in the tree, like a preview */
  onOpen: (id: string, focus?: boolean) => void
  onAdd: (parentId: string) => void
  onMenu: (id: string, rect: DOMRect) => void
  onMove: (id: string, parentId: string | null, beforeId: string | null) => void
}

export const NO_KIDS: Page[] = []
export const isBox = (index: PageIndex, p: Page) => p.kind === 'folder' || (index.kids.get(p.id) ?? NO_KIDS).length > 0 // holds other pages

/**
 * What every row of the tree shares, IntelliJ style: a click selects (or opens, with "Open with a single click"), a double-click
 * opens a page or opens and closes a folder; rows are tree items the keyboard moves through (see TreeFrame).
 */
function rowBehaviour(props: Omit<RowProps, 'page' | 'depth'>, page: Page, box: boolean, open: boolean, level: number) {
  const folder = page.kind === 'folder'
  return {
    role: 'treeitem',
    tabIndex: -1,
    'aria-selected': page.id === props.selectedId,
    'aria-expanded': box ? open : undefined,
    'aria-level': level,
    onClick: () => (props.openOnClick && !folder ? (props.onSelect(page.id), props.onOpen(page.id)) : props.onSelect(page.id)),
    onDoubleClick: () => (folder ? props.onToggle(page.id) : props.onOpen(page.id, true)),
    onContextMenu: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), props.onSelect(page.id), props.onMenu(page.id, new DOMRect(e.clientX, e.clientY, 0, 0))),
  } as const
}

/**
 * The frame around the page tree: keyboard and quick search, like IntelliJ's project view.
 * ↑ ↓ move, → opens a folder or steps into it, ← closes it or steps out to its parent, Home / End, Enter opens, the menu key
 * (or Shift+F10) opens the row's menu, and typing finds the next row whose title contains the letters typed (Esc clears).
 */
export function TreeFrame({
  label,
  selectedId,
  onSelect,
  onOpen,
  onToggle,
  onMenu,
  isOpenBox,
  parentOf,
  className,
  children,
}: {
  label: string
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string, focus?: boolean) => void
  onToggle: (id: string) => void
  onMenu: (id: string, rect: DOMRect) => void
  /** null: not a folder or a page with subpages; otherwise whether it is open */
  isOpenBox: (id: string) => boolean | null
  parentOf: (id: string) => string | null
  className?: string
  children: ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState({ query: '', found: true })
  const query = search.query
  // the letters typed so far live in a ref too: keys can arrive faster than React re-renders
  const typed = useRef('')
  const setQuery = (q: string, found = true) => {
    typed.current = q
    setSearch({ query: q, found })
  }
  const idle = useRef(0)
  const rows = () => [...(frame.current?.querySelectorAll<HTMLElement>('[data-tree-page]') ?? [])]
  const rowOf = (id: string | null) => (id ? rows().find((r) => r.dataset.treePage === id) : undefined)
  const go = (row: HTMLElement | undefined) => {
    if (!row) return
    onSelect(row.dataset.treePage!)
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest' })
  }
  const clearSoon = () => {
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => setQuery(''), 2500)
  }
  const find = (q: string, from: number) => {
    const all = rows(),
      n = all.length,
      needle = q.toLocaleLowerCase()
    for (let i = 0; i < n; i++) {
      const row = all[(from + i) % n]
      if ((row.querySelector('.ntitle')?.textContent ?? '').toLocaleLowerCase().includes(needle)) return row
    }
  }
  useEffect(() => () => window.clearTimeout(idle.current), [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const all = rows()
    const at = all.findIndex((r) => r.dataset.treePage === selectedId)
    const id = at >= 0 ? all[at].dataset.treePage! : null
    const take = () => (e.preventDefault(), e.stopPropagation())
    switch (e.key) {
      case 'ArrowDown':
        take()
        return go(all[Math.min(all.length - 1, at + 1)] ?? all[0])
      case 'ArrowUp':
        take()
        return go(all[Math.max(0, at - 1)] ?? all[0])
      case 'Home':
        take()
        return go(all[0])
      case 'End':
        take()
        return go(all[all.length - 1])
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (!id) return
        take()
        // in a right-to-left interface the arrows swap meaning, as they do on screen
        const into = (e.key === 'ArrowRight') !== (getComputedStyle(frame.current!).direction === 'rtl')
        const open = isOpenBox(id)
        if (into) return open === false ? onToggle(id) : open ? go(all[at + 1]) : undefined
        if (open) return onToggle(id)
        return go(rowOf(parentOf(id)))
      }
      case 'Enter':
        if (!id) return
        take()
        return all[at].classList.contains('folder') ? onToggle(id) : onOpen(id, true)
      case 'ContextMenu':
        if (!id) return
        take()
        return onMenu(id, all[at].getBoundingClientRect())
      case 'F10':
        if (!e.shiftKey || !id) return
        take()
        return onMenu(id, all[at].getBoundingClientRect())
      case 'Escape':
        if (!typed.current) return
        take()
        return setQuery('')
      case 'Backspace':
        if (!typed.current) return
        take()
        {
          const shorter = typed.current.slice(0, -1)
          setQuery(shorter, !shorter || !!find(shorter, 0))
        }
        return clearSoon()
    }
    if (e.key.length === 1 && (e.key !== ' ' || typed.current)) {
      take()
      const next = typed.current + e.key
      const hit = find(next, Math.max(0, at)) // stay on the current row while it still matches
      setQuery(next, !!hit)
      clearSoon()
      if (hit) go(hit)
    }
  }

  return (
    <div
      ref={frame}
      role="tree"
      aria-label={label}
      tabIndex={0}
      className={cx('tree-in', className)}
      onKeyDown={onKeyDown}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setQuery('')}
      onFocus={(e) => {
        // tabbing into the tree lands on the selected row (or the first), not on the frame
        if (e.target !== e.currentTarget || e.currentTarget.contains(e.relatedTarget)) return
        const row = rowOf(selectedId) ?? rows()[0]
        if (row) go(row)
      }}
    >
      {query && (
        <div className={'tree-search' + (search.found ? '' : ' none')} aria-live="polite">
          <Icon name="search" size={13} />
          <span dir="auto">{query}</span>
        </div>
      )}
      {children}
    </div>
  )
}

/** The compact page list (like IntelliJ's flattened packages): no nesting. Each folder / page with subpages is one row showing its whole path, with its plain pages listed under it. */
export function CompactList(props: Omit<RowProps, 'page' | 'depth'> & { roots: Page[] }) {
  const { index, roots, currentId, collapsed } = props
  const label = (p: Page) => p.title || (p.kind === 'folder' ? t('Untitled folder') : t('Untitled'))
  const file = (p: Page) => (
    <div
      key={p.id}
      data-tree-page={p.id}
      dir={dirOf(label(p))}
      className={'row tree cmp-file' + (p.id === currentId ? ' cur' : '') + (p.id === props.selectedId ? ' sel' : '')}
      {...rowBehaviour(props, p, false, false, 2)}
    >
      <span className="ic">
        <PageIcon page={p} />
      </span>
      <span className="ntitle" dir="auto">
        {label(p)}
      </span>
      <span className="acts">
        <button title={t('Options')} aria-label={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}>
          <Icon name="more-horizontal" size={16} />
        </button>
      </span>
    </div>
  )
  const out: ReactNode[] = roots.filter((p) => !isBox(index, p)).map(file)
  const walk = (p: Page, path: string[]) => {
    const kids = index.kids.get(p.id) ?? NO_KIDS
    const files = kids.filter((k) => !isBox(index, k))
    const open = !collapsed.has(p.id)
    const folder = p.kind === 'folder'
    out.push(
      <div
        key={p.id}
        data-tree-page={p.id}
        dir={dirOf(label(p))}
        className={'row tree cmp-head' + (folder ? ' folder' : '') + (p.id === currentId ? ' cur' : '') + (p.id === props.selectedId ? ' sel' : '')}
        {...rowBehaviour(props, p, files.length > 0, open, 1)}
      >
        <button
          className={'twisty' + (open ? ' open' : '')}
          style={{ visibility: files.length ? 'visible' : 'hidden' }}
          onClick={(e) => (e.stopPropagation(), props.onToggle(p.id))}
          tabIndex={-1}
          aria-label={t('Expand or collapse')}
          aria-expanded={open}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <span className="ic">
          <PageIcon page={p} />
        </span>
        <span className="ntitle" dir="auto" title={[...path, label(p)].join(' / ')}>
          {path.length > 0 && <i className="cmp-path">{(path.length > 2 ? '… / ' : '') + path.slice(-2).join(' / ')} / </i>}
          {label(p)}
        </span>
        {files.length > 0 && <span className="tree-count">{String(files.length).padStart(2, '0')}</span>}
        <span className="acts">
          <button title={t('Options')} aria-label={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}>
            <Icon name="more-horizontal" size={16} />
          </button>
          <button title={folder ? t('New page in folder') : t('New subpage')} aria-label={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(p.id))}>
            <Icon name="plus" size={16} />
          </button>
        </span>
      </div>,
    )
    if (open) files.forEach((f) => out.push(file(f)))
    kids.filter((k) => isBox(index, k)).forEach((k) => walk(k, [...path, label(p)]))
  }
  roots.filter((p) => isBox(index, p)).forEach((p) => walk(p, []))
  return <>{out}</>
}

export function TreeRow(props: RowProps) {
  const { page, depth, index, currentId, collapsed } = props
  const [zone, setZone] = useState<'before' | 'inside' | 'after' | null>(null)
  const motionOf = useUIMotion()
  const kids = index.kids.get(page.id) ?? NO_KIDS
  const open = !collapsed.has(page.id)
  const folder = page.kind === 'folder'
  const leaf = depth > 0 && !folder && !kids.length // nested plain pages: just a title, hung on the guide line
  const count = kids.length ? (index.count.get(page.id) ?? 0) : 0
  return (
    <>
      <div
        className={
          'row tree' + (folder ? ' folder' : '') + (leaf ? ' leaf' : '') + (page.id === currentId ? ' cur' : '') + (page.id === props.selectedId ? ' sel' : '') + (zone ? ' drop-' + zone : '')
        }
        data-tree-page={page.id}
        dir={dirOf(page.title)}
        draggable
        {...rowBehaviour(props, page, folder || kids.length > 0, open, depth + 1)}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-page', page.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-page')) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          const y = (e.clientY - r.top) / r.height
          setZone(y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside')
        }}
        onDragLeave={() => setZone(null)}
        onDrop={(e) => {
          e.preventDefault()
          const dragged = e.dataTransfer.getData('application/x-page')
          const z = zone
          setZone(null)
          if (!dragged || !z || dragged === page.id) return
          if (z === 'inside') return props.onMove(dragged, page.id, null)
          const sibs = (index.kids.get(page.parentId ?? null) ?? NO_KIDS).filter((p) => p.id !== dragged)
          const i = sibs.findIndex((s) => s.id === page.id)
          props.onMove(dragged, page.parentId, z === 'before' ? page.id : (sibs[i + 1]?.id ?? null))
        }}
      >
        <button
          className={'twisty' + (open ? ' open' : '')}
          style={{ visibility: kids.length || folder ? 'visible' : 'hidden' }}
          onClick={(e) => (e.stopPropagation(), props.onToggle(page.id))}
          tabIndex={-1}
          aria-label={t('Expand or collapse')}
          aria-expanded={open}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <span className="ic">
          <PageIcon page={page} />
        </span>
        <span className="ntitle" dir="auto">
          {page.title || (folder ? t('Untitled folder') : t('Untitled'))}
        </span>
        {count > 0 && <span className="tree-count">{String(count).padStart(2, '0')}</span>}
        <span className="acts">
          <button title={t('Options')} aria-label={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(page.id, e.currentTarget.getBoundingClientRect()))}>
            <Icon name="more-horizontal" size={16} />
          </button>
          <button title={folder ? t('New page in folder') : t('New subpage')} aria-label={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(page.id))}>
            <Icon name="plus" size={16} />
          </button>
        </span>
      </div>
      {kids.length > 0 && (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="kids"
              className="tree-kids"
              style={{ overflow: 'hidden' }}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={motionOf.transition}
            >
              {kids.map((k) => (
                <TreeRow key={k.id} {...props} page={k} depth={depth + 1} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </>
  )
}
