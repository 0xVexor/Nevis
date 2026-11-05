import { useState, type ReactNode } from 'react'
import type { Page } from './repo'
import type { PageIndex } from './pageIndex'
import { PageIcon } from './PageIcon'
import { AnimatePresence, motion } from 'motion/react'
import { dirOf, useUIMotion, Icon } from './design-system'
import { t } from './i18n'

export interface RowProps {
  page: Page
  depth: number
  index: PageIndex
  currentId: string
  collapsed: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  onAdd: (parentId: string) => void
  onMenu: (id: string, rect: DOMRect) => void
  onMove: (id: string, parentId: string | null, beforeId: string | null) => void
}

export const NO_KIDS: Page[] = []
export const isBox = (index: PageIndex, p: Page) => p.kind === 'folder' || (index.kids.get(p.id) ?? NO_KIDS).length > 0 // holds other pages

/** The compact page list (like IntelliJ's flattened packages): no nesting. Each folder / page with subpages is one row showing its whole path, with its plain pages listed under it. */
export function CompactList(props: Omit<RowProps, 'page' | 'depth'> & { roots: Page[] }) {
  const { index, roots, currentId, collapsed } = props
  const label = (p: Page) => p.title || (p.kind === 'folder' ? t('Untitled folder') : t('Untitled'))
  const file = (p: Page) => (
    <div
      key={p.id}
      data-tree-page={p.id}
      dir={dirOf(label(p))}
      className={'row tree cmp-file' + (p.id === currentId ? ' cur' : '')}
      onClick={() => props.onOpen(p.id)}
      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), props.onMenu(p.id, new DOMRect(e.clientX, e.clientY, 0, 0)))}
    >
      <span className="ic">
        <PageIcon page={p} />
      </span>
      <span className="ntitle" dir="auto">
        {label(p)}
      </span>
      <span className="acts">
        <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}>
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
        className={'row tree cmp-head' + (folder ? ' folder' : '') + (p.id === currentId ? ' cur' : '')}
        onClick={() => (folder ? props.onToggle(p.id) : props.onOpen(p.id))}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), props.onMenu(p.id, new DOMRect(e.clientX, e.clientY, 0, 0)))}
      >
        <button
          className={'twisty' + (open ? ' open' : '')}
          style={{ visibility: files.length ? 'visible' : 'hidden' }}
          onClick={(e) => (e.stopPropagation(), props.onToggle(p.id))}
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
          <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}>
            <Icon name="more-horizontal" size={16} />
          </button>
          <button title={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(p.id))}>
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
        className={'row tree' + (folder ? ' folder' : '') + (leaf ? ' leaf' : '') + (page.id === currentId ? ' cur' : '') + (zone ? ' drop-' + zone : '')}
        data-tree-page={page.id}
        dir={dirOf(page.title)}
        draggable
        onClick={() => (folder ? props.onToggle(page.id) : props.onOpen(page.id))}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), props.onMenu(page.id, new DOMRect(e.clientX, e.clientY, 0, 0)))}
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
          <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(page.id, e.currentTarget.getBoundingClientRect()))}>
            <Icon name="more-horizontal" size={16} />
          </button>
          <button title={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(page.id))}>
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
