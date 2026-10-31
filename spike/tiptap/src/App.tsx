import { setPreference } from './preferenceEvents'
import { Brand } from './Brand'
import { UpdateCenter } from './UpdateUI'
import { shortcutLabel } from './shortcuts'
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { repo, gcFiles, TRASH_DAYS } from './store'
import type { Cover, Page, PageStatus } from './repo'
import { SettingsView } from './SettingsPage'
import { Tasks } from './Tasks'
import { Drawings } from './Drawings'
import { Databases } from './Databases'
import { SideTip } from './SideTip'
import { removeInlineDrawing, type DrawingInfo } from './drawingData'
import { BoardView } from './BoardView'
const DatabasePage = lazy(() => import('./database/ui/DatabasePage').then((m) => ({ default: m.DatabasePage })))
import { warmDrawing } from './editor/excalidraw'
import { CoverBanner, CoverPicker } from './Cover'
import { PagePanel } from './PagePanel'
import { PageIcon } from './PageIcon'
import { isDark, updateSettings, useSettings } from './settings'
import { BackupError, buildBackup, download, pageToMarkdown, restoreBackup } from './backup'
import { exportAllZip, importMarkdown, importVault, pickDirectory, pickFiles } from './io'
import { PagesTable } from './PagesTable'
import { HorizontalScroll } from './HorizontalScroll'
import { Flashcards } from './Flashcards'
import { SidebarTags } from './SidebarTags'
import { Explorer } from './Explorer'
import { Templates, TEMPLATE_GLYPH, BOARD_TEMPLATE, DATABASE_TEMPLATE } from './TemplateGallery'
import { getTemplates } from './templates'
import { PageView, type SaveState } from './PageView'
import { buildIndex, type PageIndex } from './pageIndex'
import { ReaderBar, loadReaderCfg, type ReaderCfg } from './ReaderBar'
import { BackupSettings } from './BackupSettings'
import { Vaults } from './Vaults'
import { WorkspaceCard } from './VaultSwitcher'
import { GraphView } from './GraphView'
import { searchPages } from './searchIndex'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { saveBeforeUpdate } from './updateSave'
import { flushPreferences } from './sharedPreferences'
import { isTauri, kvGet, kvSet } from './db'
import { watchDueCards } from './cardsDue'
import { normalizeFa } from './normalize'
import { MenuItem, MenuLabel, MenuSep, NameDialog, Popover, SearchModal, Toast, TrashModal, type PaletteCommand } from './ui'
import { Home } from './Home'
import { iconNode } from './iconSet'
import * as Ic from './icons'
import { printPage } from './print'
import { confirmDialog } from './dialog'
import { OPEN_PAGE, PAGES_CHANGED } from './editor/pageLink'
import { t } from './i18n'

const PAGE_W = { min: 640, max: 1800, def: 1400, step: 80 }

const store = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const put = (k: string, v: unknown) => {
  try {
    setPreference(k, JSON.stringify(v))
  } catch {
    /* private mode etc. — preferences are optional */
  }
}

interface RowProps {
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

const NO_KIDS: Page[] = []
const isBox = (index: PageIndex, p: Page) => p.kind === 'folder' || (index.kids.get(p.id) ?? NO_KIDS).length > 0 // holds other pages
const SIDE_MIN = 160
const SIDE_MAX = 600
const BIG_TREE = 150 // pages from which the sidebar tree starts collapsed

/** The compact page list (like IntelliJ's flattened packages): no nesting. Each folder / page with subpages is one row showing its whole path, with its plain pages listed under it. */
function CompactList(props: Omit<RowProps, 'page' | 'depth'> & { roots: Page[] }) {
  const { index, roots, currentId, collapsed } = props
  const label = (p: Page) => p.title || (p.kind === 'folder' ? t('Untitled folder') : t('Untitled'))
  const file = (p: Page) => (
    <div key={p.id} className={'row tree cmp-file' + (p.id === currentId ? ' cur' : '')} onClick={() => props.onOpen(p.id)} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), props.onMenu(p.id, new DOMRect(e.clientX, e.clientY, 0, 0)))}>
      <span className="ic"><PageIcon page={p} /></span>
      <span className="ntitle" dir="auto">{label(p)}</span>
      <span className="acts">
        <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}><Ic.Dots size={16} /></button>
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
      <div key={p.id} className={'row tree cmp-head' + (folder ? ' folder' : '') + (p.id === currentId ? ' cur' : '')} onClick={() => (folder ? props.onToggle(p.id) : props.onOpen(p.id))} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), props.onMenu(p.id, new DOMRect(e.clientX, e.clientY, 0, 0)))}>
        <button className={'twisty' + (open ? ' open' : '')} style={{ visibility: files.length ? 'visible' : 'hidden' }} onClick={(e) => (e.stopPropagation(), props.onToggle(p.id))} aria-label={t('Expand or collapse')}>
          <Ic.Chevron size={14} />
        </button>
        <span className="ic"><PageIcon page={p} /></span>
        <span className="ntitle" dir="auto" title={[...path, label(p)].join(' / ')}>
          {path.length > 0 && <i className="cmp-path">{(path.length > 2 ? '… / ' : '') + path.slice(-2).join(' / ')} / </i>}
          {label(p)}
        </span>
        {files.length > 0 && <span className="tree-count">{String(files.length).padStart(2, '0')}</span>}
        <span className="acts">
          <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(p.id, e.currentTarget.getBoundingClientRect()))}><Ic.Dots size={16} /></button>
          <button title={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(p.id))}><Ic.Plus size={16} /></button>
        </span>
      </div>,
    )
    if (open) files.forEach((f) => out.push(file(f)))
    kids.filter((k) => isBox(index, k)).forEach((k) => walk(k, [...path, label(p)]))
  }
  roots.filter((p) => isBox(index, p)).forEach((p) => walk(p, []))
  return <>{out}</>
}

function TreeRow(props: RowProps) {
  const { page, depth, index, currentId, collapsed } = props
  const [zone, setZone] = useState<'before' | 'inside' | 'after' | null>(null)
  const kids = index.kids.get(page.id) ?? NO_KIDS
  const open = !collapsed.has(page.id)
  const folder = page.kind === 'folder'
  const leaf = depth > 0 && !folder && !kids.length // nested plain pages: just a title, hung on the guide line
  const count = kids.length ? (index.count.get(page.id) ?? 0) : 0
  return (
    <>
      <div
        className={'row tree' + (folder ? ' folder' : '') + (leaf ? ' leaf' : '') + (page.id === currentId ? ' cur' : '') + (zone ? ' drop-' + zone : '')}
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
        >
          <Ic.Chevron size={14} />
        </button>
        <span className="ic"><PageIcon page={page} /></span>
        <span className="ntitle" dir="auto">{page.title || (folder ? t('Untitled folder') : t('Untitled'))}</span>
        {count > 0 && <span className="tree-count">{String(count).padStart(2, '0')}</span>}
        <span className="acts">
          <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(page.id, e.currentTarget.getBoundingClientRect()))}><Ic.Dots size={16} /></button>
          <button title={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(page.id))}><Ic.Plus size={16} /></button>
        </span>
      </div>
      {open && kids.length > 0 && <div className="tree-kids">{kids.map((k) => <TreeRow key={k.id} {...props} page={k} depth={depth + 1} />)}</div>}
    </>
  )
}

export default function App() {
  const [pages, setPages] = useState<Page[]>(() => repo.list())
  const [currentId, setCurrentIdRaw] = useState<string>(() => localStorage.getItem('not.current') || repo.pagesOnly()[0]?.id || '')
  const [view, setView] = useState<'home' | 'page' | 'settings' | 'tasks' | 'drawings' | 'databases' | 'files'>('home')
  const [panelOpen, setPanelOpen] = useState<boolean>(() => store('not.panel.v2', false))
  const [coverMenu, setCoverMenu] = useState<DOMRect | null>(null)
  // opening any page (sidebar, search, link, breadcrumb…) also leaves the settings view
  const setCurrentId = useCallback((id: string) => (setView('page'), setCurrentIdRaw(id)), [])
  // a big vault starts with its folders closed (except the way down to the open page): thousands of rows are slow to build and no use to scan
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const all = repo.list()
    if (all.length < BIG_TREE) return new Set()
    const byId = new Map(all.map((p) => [p.id, p]))
    const keep = new Set<string>()
    for (let p = byId.get(localStorage.getItem('not.current') ?? ''); p?.parentId && !keep.has(p.parentId); p = byId.get(p.parentId)) keep.add(p.parentId)
    const parents = new Set(all.map((p) => p.parentId))
    return new Set(all.filter((p) => !keep.has(p.id) && parents.has(p.id)).map((p) => p.id))
  })
  const [shut, setShut] = useState<{ favs: boolean; pages: boolean; tags: boolean; saved: boolean }>({ favs: false, pages: false, tags: false, saved: false })
  const [save, setSave] = useState<SaveState>('saved')
  const [sideOpen, setSideOpen] = useState<boolean>(() => store('not.side', true))
  const [sideW, setSideW] = useState<number | null>(() => store<number | null>('not.sideW', null)) // null: the width of the chosen sidebar style
  const [sideDrag, setSideDrag] = useState(false)
  useEffect(() => put('not.sideW', sideW), [sideW])
  const [searching, setSearching] = useState(false)
  const [searchInit, setSearchInit] = useState('') // query to start the search with (a saved search)
  const [tagFilter, setTagFilter] = useState<string | null>(null) // sidebar: show only pages with this tag
  const [saved, setSaved] = useState<{ id: string; name: string; query: string }[]>([])
  useEffect(() => void kvGet<{ id: string; name: string; query: string }[]>('savedSearches').then((s) => setSaved(Array.isArray(s) ? s : [])), [])
  const saveSaved = (next: { id: string; name: string; query: string }[]) => (setSaved(next), void kvSet('savedSearches', next))
  const [trashOpen, setTrashOpen] = useState(false)
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null)
  const [naming, setNaming] = useState<{ title: string; label: string; initial: string; action: string; onSubmit: (name: string) => void } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [dueCards, setDueCards] = useState(0)
  useEffect(() => watchDueCards(setDueCards, isTauri), [])
  const [cardsOpen, setCardsOpen] = useState(false)
  const [dataMenu, setDataMenu] = useState<DOMRect | null>(null)
  const [blankMenu, setBlankMenu] = useState<DOMRect | null>(null) // right-click on empty sidebar space
  const [trashTick, setTrashTick] = useState(0)
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [reader, setReader] = useState(false)
  const [readerCfg, setReaderCfg] = useState<ReaderCfg>(loadReaderCfg)
  const [pageW, setPageW] = useState<number>(() => Number(localStorage.getItem('not.page.width')) || PAGE_W.def)
  const readerRef = useRef(reader)
  readerRef.current = reader
  const settings = useSettings()

  const refresh = useCallback(() => setPages(repo.list()), [])
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<{ title: string; propertyName: string }>).detail
      setToast({ msg: t('Reminder: {title} ({prop})', { title: r.title || t('Untitled'), prop: r.propertyName }) })
    }
    window.addEventListener('db-reminder', on)
    return () => window.removeEventListener('db-reminder', on)
  }, [])
  const current = pages.find((p) => p.id === currentId && p.kind !== 'folder') ?? pages.find((p) => p.kind !== 'folder')

  useEffect(() => {
    if (current) setPreference('not.current', current.id)
  }, [current])
  useEffect(() => put('not.side', sideOpen), [sideOpen])
  // views lay themselves out by the width of the main panel (window minus sidebar), not the window: data-main on .app is lg / md / sm / xs
  const mainWatch = useRef<ResizeObserver>(undefined)
  const mainRef = useCallback((main: HTMLElement | null) => {
    mainWatch.current?.disconnect()
    const app = main?.parentElement
    if (!main || !app) return
    const ro = new ResizeObserver(() => {
      const w = main.clientWidth
      app.dataset.main = w > 940 ? 'lg' : w > 700 ? 'md' : w > 480 ? 'sm' : 'xs'
    })
    ro.observe(main)
    mainWatch.current = ro
  }, [])
  // a narrow window has no room for the sidebar beside the page: it starts out of the way (Ctrl+\ or the button brings it back)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    if (mq.matches) setSideOpen(false)
    const on = (e: MediaQueryListEvent) => e.matches && setSideOpen(false)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => put('not.panel.v2', panelOpen), [panelOpen])
  // tools opened from the page panel (it talks to us through window events, so it needs no extra props)
  useEffect(() => {
    const table = () => setTableOpen(true)
    const cards = () => setCardsOpen(true)
    const toggleReader = () => setReader((r) => !r)
    window.addEventListener('toggle-reader', toggleReader)
    window.addEventListener('open-table', table)
    window.addEventListener('open-cards', cards)
    return () => {
      window.removeEventListener('toggle-reader', toggleReader)
      window.removeEventListener('open-table', table)
      window.removeEventListener('open-cards', cards)
    }
  }, [])
  useEffect(() => {
    const open = (e: Event) => setCurrentId((e as CustomEvent<string>).detail)
    const changed = () => refresh()
    window.addEventListener(OPEN_PAGE, open)
    window.addEventListener(PAGES_CHANGED, changed)
    window.addEventListener('external-change', changed)
    // desktop: a save found a newer version on disk (changed by another program) and put it in the page history first
    const kept = () => setToast({ msg: t('This page was changed outside the app while you were editing. Its version is kept in the page history.') })
    // desktop: the vault folder vanished while the app was open (moved, deleted, disk unplugged): nothing is written until it is back
    const storageError = (e: Event) => {
      if (String((e as CustomEvent).detail).includes('VAULT_MISSING')) setToast({ msg: t('The vault folder was not found. Open Workspaces to locate it or download it again.') })
    }
    const layoutNotice = (e: Event) => setToast({ msg: String((e as CustomEvent).detail) })
    window.addEventListener('layout-message', layoutNotice)
    window.addEventListener('page-conflict', kept)
    window.addEventListener('storage-error', storageError)
    return () => {
      window.removeEventListener(OPEN_PAGE, open)
      window.removeEventListener(PAGES_CHANGED, changed)
      window.removeEventListener('external-change', changed)
      window.removeEventListener('layout-message', layoutNotice)
      window.removeEventListener('page-conflict', kept)
      window.removeEventListener('storage-error', storageError)
    }
  }, [refresh])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === '\\') (e.preventDefault(), setSideOpen((s) => !s))
      // Alt + = / Alt + -: wider / narrower text column (in reader mode: the reader page)
      if (e.altKey && !mod && !e.shiftKey && (e.code === 'Equal' || e.code === 'Minus')) {
        e.preventDefault()
        const d = e.code === 'Equal' ? PAGE_W.step : -PAGE_W.step
        if (readerRef.current) setReaderCfg((c) => { const n = { ...c, width: Math.min(1400, Math.max(480, c.width + d)) }; setPreference('not.reader.cfg', JSON.stringify(n)); return n })
        else setPageW((w) => { const n = Math.min(PAGE_W.max, Math.max(PAGE_W.min, w + d)); setPreference('not.page.width', String(n)); return n })
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'Period') (e.preventDefault(), setReader((r) => !r)) // physical key: works with the Persian layout
      if (e.key === 'Escape' && !document.querySelector('.lightbox')) setReader(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  // Ctrl/Cmd+K opens search from anywhere in the app: capture phase (the editor cannot swallow it) and the physical key
  // (so it also works with the Persian keyboard layout, where e.key is not “k”)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
        e.preventDefault()
        e.stopPropagation()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const addDatabase = (parentId: string | null) => {
    void import('./database/runtime').then((m) => m.getDatabase()).then((svc) => svc.one<{ hostPageId: string }>('database.create', { parentPageId: parentId, title: t('Untitled database') })).then((r) => {
      if (parentId) expand(parentId)
      refresh()
      setCurrentId(r.hostPageId)
    }).catch((e) => setToast({ msg: String(e?.message ?? e) }))
  }
  const add = (parentId: string | null, kind?: 'board' | 'todo') => {
    const p = repo.create(parentId, kind)
    if (kind === 'todo') repo.update(p.id, { title: t('To-do list') }, { history: false })
    if (parentId) expand(parentId)
    refresh()
    setCurrentId(p.id)
  }
  useEffect(() => {
    const open = (e: Event) => (setSearchInit(String((e as CustomEvent).detail ?? '')), setSearching(true))
    window.addEventListener('open-search', open)
    return () => window.removeEventListener('open-search', open)
  }, [])
  const [tplOpen, setTplOpen] = useState(false)
  const addFromTemplate = (id: string) => {
    setTplOpen(false)
    if (id === BOARD_TEMPLATE) return add(null, 'board')
    if (id === DATABASE_TEMPLATE) return addDatabase(null)
    const p = repo.create(null, id === 'todo' ? 'todo' : 'page')
    const tp = getTemplates().find((x) => x.id === id)
    if (tp) {
      repo.update(p.id, { title: tp.pageTitle, icon: 'i:' + (TEMPLATE_GLYPH[tp.id] ?? 'page') })
      ;(window as any).__pendingTpl = { pageId: p.id, id }
    }
    refresh()
    setView('page')
    setCurrentId(p.id)
  }
  const addFolder = (parentId: string | null) =>
    setNaming({
      title: t('New folder'), label: t('Folder name:'), initial: t('New folder'), action: t('Create'),
      onSubmit: (name) => {
        const f = repo.create(parentId, 'folder')
        repo.update(f.id, { title: name })
        if (parentId) expand(parentId)
        refresh()
      },
    })
  const rename = (id: string) => {
    const p = repo.get(id)
    if (!p) return
    setNaming({ title: t('Rename'), label: t('New name:'), initial: p.title, action: t('Save'), onSubmit: (name) => (repo.update(id, { title: name }), refresh()) })
  }
  const del = (id: string) => {
    const p = repo.get(id)
    if (!p) return
    repo.remove(id) // soft delete: recoverable from the trash, so no confirmation dialog
    refresh()
    if (id === currentId) setCurrentId(repo.pagesOnly()[0]?.id ?? '')
    setToast({ msg: t('“{title}” moved to trash', { title: p.title || t('Untitled') }), undo: () => (repo.restoreFromTrash(id), refresh(), p.kind !== 'folder' && setCurrentId(id)) })
  }
  const delDrawing = (d: DrawingInfo) => {
    if (d.source === 'board') return del(d.pageId)
    const before = removeInlineDrawing(d.pageId, Number(d.key.split(':')[1]))
    if (!before) return
    refresh()
    setToast({ msg: t('Drawing deleted'), undo: () => (repo.update(d.pageId, { content: before }), refresh()) })
  }
  const duplicate = (id: string) => {
    const p = repo.get(id)
    if (!p) return
    const c = repo.create(p.parentId, p.kind)
    repo.update(c.id, { title: p.title ? p.title + ' ' + t('(copy)') : '', icon: p.icon, cover: p.cover, titleDir: p.titleDir, tags: p.tags ? [...p.tags] : undefined, status: p.status, content: structuredClone(p.content) }, { copyContent: true })
    refresh()
    if (p.kind !== 'folder') setCurrentId(c.id)
  }
  const purge = async (p: Page) => {
    if (!(await confirmDialog({ title: t('Delete permanently'), message: t('“{title}” will be deleted permanently. This cannot be undone.', { title: p.title || t('Untitled') }), confirmLabel: t('Delete permanently'), danger: true }))) return
    repo.purge(p.id)
    await gcFiles()
    refresh()
    setTrashTick((t) => t + 1)
  }
  const emptyTrash = async () => {
    if (!(await confirmDialog({ title: t('Empty trash'), message: t('Permanently delete everything in the trash? This cannot be undone.'), confirmLabel: t('Empty trash'), danger: true }))) return
    repo.emptyTrash()
    await gcFiles()
    refresh()
    setTrashTick((t) => t + 1)
  }
  const restore = (id: string) => {
    repo.restoreFromTrash(id)
    refresh()
    setTrashTick((t) => t + 1)
    if (repo.get(id)?.kind !== 'folder') setCurrentId(id)
  }
  const fav = (id: string) => {
    const p = repo.get(id)
    if (p) repo.update(id, { favorite: !p.favorite })
    refresh()
  }
  // state updaters must be pure (React StrictMode runs them twice): copy the set instead of mutating it
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const expand = (id: string) => setCollapsed((s) => { const n = new Set(s); n.delete(id); return n })
  const move = (id: string, parentId: string | null, beforeId: string | null) => {
    if (repo.move(id, parentId, beforeId)) {
      if (parentId) expand(parentId)
      refresh()
    }
  }
  const stamp = () => new Date().toISOString().slice(0, 10)
  const doBackup = async () => {
    const name = `notes-backup-${stamp()}.json`
    try {
      if (!isTauri) return download(name, await buildBackup(repo))
      await saveBeforeUpdate(); await repo.flushBeforeUpdate(); await flushPreferences()
      const path = await saveDialog({ defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (path) await invoke('vault_backup_save', { path })
    } catch (error) { setToast({ msg: t('Backup failed') + ': ' + String(error) }) }
  }
  const doExportAll = async () => {
    try {
      const r = await exportAllZip()
      download(`notes-export-${stamp()}.zip`, r.blob)
      setToast({ msg: t('{pages} pages and {files} images exported', { pages: r.pages, files: r.files }) })
    } catch (e) {
      console.error(e)
      setToast({ msg: t('Export failed') })
    }
  }
  const doVault = async () => {
    const files = await pickDirectory()
    if (!files.length) return
    try {
      setToast({ msg: t('Importing vault…') })
      const r = await importVault(files, (done, total) => setToast({ msg: t('Importing vault… {done}/{total}', { done, total }) }))
      refresh()
      setToast({ msg: t('Imported “{vault}”: {pages} pages, {folders} folders, {images} images', { vault: r.vault, pages: r.pages, folders: r.folders, images: r.images }) })
    } catch (e) {
      console.error(e)
      setToast({ msg: t('Import failed') })
    }
  }
  const setStatus = (id: string, status: PageStatus | undefined) => {
    repo.update(id, { status })
    refresh()
  }
  const doImport = async () => {
    const files = await pickFiles('.md,.markdown,.txt,text/markdown,text/plain', true)
    if (!files.length) return
    try {
      const made = await importMarkdown(files)
      refresh()
      setCurrentId(made[0].id)
      setToast({ msg: t('{n} pages imported from Markdown', { n: made.length }) })
    } catch (e) {
      console.error(e)
      setToast({ msg: t('Import failed') })
    }
  }
  const doRestore = async () => {
    const [f] = await pickFiles('application/json')
    if (!f || !(await confirmDialog({ title: t('Restore from backup'), message: isTauri ? t('The backup will open in a new disconnected workspace. Current files stay intact. Continue?') : t('All current pages will be replaced by the backup. Continue?'), confirmLabel: t('Restore'), danger: true }))) return
    try {
      const r = await restoreBackup(repo, await f.text())
      refresh()
      setCurrentId(repo.pagesOnly()[0]?.id ?? '')
      setToast({ msg: t('{pages} pages and {files} files restored', { pages: r.pages, files: r.files }) })
    } catch (err) {
      setToast({ msg: err instanceof BackupError ? err.message : t('Restore failed') })
    }
  }
  const exportMd = async (id: string) => {
    const p = repo.get(id)
    if (p) download((p.title || 'page') + '.md', new Blob([await pageToMarkdown(p)], { type: 'text/markdown' }))
  }
  const dark = isDark(settings)
  const setCover = (cover: Cover | undefined) => {
    if (!current) return
    repo.update(current.id, { cover })
    refresh()
  }

  const index = useMemo(() => buildIndex(pages), [pages])
  const roots = index.kids.get(null) ?? []
  const favs = pages.filter((p) => p.favorite)
  // tags with their page counts (letters compared after Persian normalization, so ي/ی count as one tag)
  const tagList = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number }>()
    for (const p of pages) if (p.kind !== 'folder') for (const tg of p.tags ?? []) { const key = normalizeFa(tg); const g = m.get(key); g ? g.count++ : m.set(key, { key, label: tg, count: 1 }) }
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fa'))
  }, [pages])
  const taggedPages = useMemo(() => (tagFilter ? pages.filter((p) => p.kind !== 'folder' && p.tags?.some((tg) => normalizeFa(tg) === tagFilter)) : []), [pages, tagFilter])
  const crumbs = useMemo(() => {
    const out: Page[] = []
    for (let p: Page | undefined = current; p; p = p.parentId ? pages.find((x) => x.id === p!.parentId) : undefined) out.unshift(p)
    return out
  }, [current, pages])
  const commands: PaletteCommand[] = [
    { id: 'new-page', label: t('New page'), icon: <Ic.Page />, keywords: 'create add صفحه جدید', run: () => add(null) },
    { id: 'templates', label: t('Templates'), icon: <Ic.Blocks />, keywords: 'template قالب تمپلیت', run: () => setTplOpen(true) },
    { id: 'new-folder', label: t('New folder'), icon: <Ic.Folder />, keywords: 'create add پوشه', run: () => addFolder(null) },
    { id: 'compact-pages', label: settings.pagesView === 'compact' ? t('Show pages as a tree') : t('Show pages as a compact list'), icon: <Ic.Layers />, keywords: 'compact flat list tree pages sidebar intellij فشرده لیست درخت صفحه', run: () => updateSettings({ pagesView: settings.pagesView === 'compact' ? 'tree' : 'compact' }) },
    { id: 'new-todo', label: t('New to-do list'), icon: <Ic.Checklist />, keywords: 'create add todo task list checklist لیست کار تسک چک‌لیست جدید', run: () => add(null, 'todo') },
    { id: 'new-database', label: t('New database'), icon: <Ic.Table />, keywords: 'create add table database board calendar پایگاه داده جدول جدید', run: () => addDatabase(null) },
    { id: 'new-board', label: t('New board'), icon: <Ic.Pencil />, keywords: 'create add whiteboard drawing canvas sketch بوم نقاشی طراحی جدید', run: () => add(null, 'board') },
    ...(current && view === 'page' ? [
      { id: 'subpage', label: t('Add subpage'), icon: <Ic.Plus />, keywords: 'زیرصفحه', run: () => add(current.id) },
      { id: 'fav', label: current.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: <Ic.Star filled={current.favorite} />, keywords: 'star pin علاقه‌مندی', run: () => fav(current.id) },
      { id: 'reader', label: t('Reader mode'), icon: <Ic.Reader />, keywords: 'read مطالعه', hint: 'Ctrl .', run: () => setReader(true) },
      { id: 'export-md', label: t('Export Markdown'), icon: <Ic.Markdown />, keywords: 'download خروجی', run: () => exportMd(current.id) },
    ] : []),
    { id: 'home', label: t('Home'), icon: <Ic.Home />, keywords: 'dashboard خانه', run: () => setView('home') },
    { id: 'table', label: t('Pages table'), icon: <Ic.Table />, keywords: 'database جدول', run: () => setTableOpen(true) },
    { id: 'graph', label: t('Graph view'), icon: <Ic.Link />, keywords: 'graph links map backlinks گراف نقشه ارتباط پیوند', run: () => setGraphOpen(true) },
    { id: 'files', label: t('Files'), icon: <Ic.Folders />, keywords: 'files explorer folders manage فایل مدیریت پوشه فایل‌ها', run: () => setView('files') },
    { id: 'tasks', label: t('Tasks'), icon: <Ic.Checklist />, keywords: 'tasks todo checklist کارها وظایف چک لیست', run: () => setView('tasks') },
    { id: 'databases', label: t('Databases'), icon: <Ic.Table />, keywords: 'databases tables projects all database پایگاه داده دیتابیس پروژه جدول', run: () => setView('databases') },
    { id: 'drawings', label: t('Drawings'), icon: <Ic.Pencil />, keywords: 'drawings boards whiteboard sketch canvas excalidraw نقاشی بوم طراحی ترسیم', run: () => setView('drawings') },
    { id: 'cards', label: t('Flashcards'), icon: <Ic.Cards />, keywords: 'review srs فلش‌کارت', run: () => setCardsOpen(true) },
    { id: 'trash', label: t('Trash'), icon: <Ic.Trash />, keywords: 'deleted سطل', run: () => setTrashOpen(true) },
    { id: 'theme', label: dark ? t('Light mode') : t('Dark mode'), icon: dark ? <Ic.Sun /> : <Ic.Moon />, keywords: 'theme dark light تم', run: () => updateSettings({ theme: dark ? 'light' : 'dark' }) },
    { id: 'sidebar', label: sideOpen ? t('Close sidebar') : t('Open sidebar'), icon: <Ic.Sidebar />, keywords: 'side panel نوار کناری', hint: 'Ctrl \\', run: () => setSideOpen((o) => !o) },
    { id: 'import', label: t('Import Markdown files…'), icon: <Ic.Upload />, keywords: 'وارد کردن', run: doImport },
    { id: 'vault', label: t('Import Obsidian vault (folder)…'), icon: <Ic.Folder />, keywords: 'obsidian', run: doVault },
    { id: 'export-all', label: t('Export all pages (zip with Markdown & images)'), icon: <Ic.Download />, keywords: 'zip', run: doExportAll },
    { id: 'backup', label: t('Full backup (JSON)'), icon: <Ic.Save />, keywords: 'پشتیبان', run: doBackup },
    ...[{ id: 'data-folder', label: t('Workspaces…'), icon: <Ic.Folder />, keywords: 'vault switch workspace پوشه داده', run: () => setFolderOpen(true) }],
    { id: 'auto-backup', label: t('Automatic backup to folder…'), icon: <Ic.Save />, keywords: 'پشتیبان خودکار', run: () => setBackupOpen(true) },
    { id: 'settings', label: t('Settings'), icon: <Ic.Settings />, keywords: 'preferences تنظیمات', run: () => setView('settings') },
  ]
  const menuPage = menu ? pages.find((p) => p.id === menu.id) : undefined

  const rowProps = { index, currentId: current?.id ?? '', collapsed, onToggle: toggle, onOpen: setCurrentId, onAdd: add, onMenu: (id: string, rect: DOMRect) => setMenu({ id, rect }), onMove: move }

  return (
    <div className={'app' + (reader && view === 'page' && current ? ' reading' : '')} style={{ ['--page-w' as any]: pageW + 'px', ['--r-scale' as any]: readerCfg.scale, ['--r-width' as any]: readerCfg.width + 'px' }}>
      <aside className={'side' + (sideOpen ? '' : ' closed') + (sideDrag ? ' resizing' : '')} style={sideW ? { ['--side-w' as any]: sideW + 'px' } : undefined} onContextMenu={(e) => (e.preventDefault(), setBlankMenu(new DOMRect(e.clientX, e.clientY, 0, 0)))}>
        <div
          className="side-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Resize sidebar')}
          title={t('Drag to resize, double-click to reset')}
          onDoubleClick={() => setSideW(null)}
          onPointerDown={(e) => {
            const aside = e.currentTarget.parentElement!
            const rtl = getComputedStyle(aside).direction === 'rtl'
            const edge = rtl ? aside.getBoundingClientRect().right : aside.getBoundingClientRect().left
            e.currentTarget.setPointerCapture(e.pointerId)
            setSideDrag(true)
            const move = (ev: PointerEvent) => setSideW(Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, rtl ? edge - ev.clientX : ev.clientX - edge))))
            const up = () => (setSideDrag(false), window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up))
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        />
        <div className="ws">
          <span className="ws-logo"><Ic.Logo size={32} /></span>
          <Brand className="ws-name" />
          <button className="icon-btn" title={t('Close sidebar  Ctrl+\\')} onClick={() => setSideOpen(false)}><Ic.Sidebar /></button>
        </div>

        <div className="side-scroll">
          <button className="row plain search-row" onClick={() => setSearching(true)}>
            <span className="ic"><Ic.Search /></span><span className="ntitle">{t('Search')}...</span><kbd dir="ltr">{shortcutLabel(['Mod', 'K'])}</kbd>
          </button>

          <button className={'row plain' + (view === 'home' ? ' cur' : '')} onClick={() => setView('home')}>
            <span className="ic"><Ic.Home /></span><span className="ntitle">{t('Home')}</span>
          </button>

          <button className={'row plain' + (view === 'tasks' ? ' cur' : '')} onClick={() => setView('tasks')}>
            <span className="ic"><Ic.Checklist /></span><span className="ntitle">{t('Tasks')}</span>
          </button>

          <button className={'row plain' + (view === 'databases' ? ' cur' : '')} onClick={() => setView('databases')}>
            <span className="ic"><Ic.Table /></span><span className="ntitle">{t('Databases')}</span>
          </button>

          <button className={'row plain' + (view === 'drawings' ? ' cur' : '')} onPointerEnter={warmDrawing} onClick={() => setView('drawings')}>
            <span className="ic"><Ic.Pencil /></span><span className="ntitle">{t('Drawings')}</span>
          </button>

          <button className="row plain" onClick={() => setTplOpen(true)}><span className="ic"><Ic.Blocks /></span><span className="ntitle">{t('Templates')}</span></button>

          <button className="row plain" onClick={() => setCardsOpen(true)}><span className="ic"><Ic.Cards /></span><span className="ntitle">{t('Flashcards')}</span>{dueCards > 0 && <span className="badge">{dueCards}</span>}</button>

          <button className={'row plain' + (view === 'files' ? ' cur' : '')} onClick={() => setView('files')}>
            <span className="ic"><Ic.Folders /></span><span className="ntitle">{t('Files')}</span>
          </button>

          <button className="row plain" onClick={() => setGraphOpen(true)}>
            <span className="ic"><Ic.Link /></span><span className="ntitle">{t('Graph view')}</span>
          </button>

          {favs.length > 0 && (
            <>
              <button className={"section" + (shut.favs ? " shut" : "")} onClick={() => setShut((s) => ({ ...s, favs: !s.favs }))}>{t('Favorites')}<Ic.Chevron size={13} /></button>
              {!shut.favs && favs.map((p) => (
                <div key={p.id} className={'row' + (p.id === current?.id ? ' cur' : '')} style={{ paddingInlineStart: 24 }} onClick={() => setCurrentId(p.id)}>
                  <span className="ic"><PageIcon page={p} /></span>
                  <span className="ntitle" dir="auto">{p.title || t('Untitled')}</span>
                </div>
              ))}
            </>
          )}

          {saved.length > 0 && (
            <>
              <button className={"section" + (shut.saved ? " shut" : "")} onClick={() => setShut((s) => ({ ...s, saved: !s.saved }))}>{t('Saved searches')}<Ic.Chevron size={13} /></button>
              {!shut.saved && saved.map((s) => (
                <div key={s.id} className="row saved-row" style={{ paddingInlineStart: 24 }} title={s.query} onClick={() => (setSearchInit(s.query), setSearching(true))}>
                  <span className="ic"><Ic.Search size={15} /></span>
                  <span className="ntitle" dir="auto">{s.name}</span>
                  <span className="acts"><button title={t('Delete')} onClick={(e) => (e.stopPropagation(), saveSaved(saved.filter((x) => x.id !== s.id)))}><Ic.Close size={14} /></button></span>
                </div>
              ))}
            </>
          )}

          {<button className={"section" + (shut.pages ? " shut" : "")} onClick={() => setShut((s) => ({ ...s, pages: !s.pages }))}>{t('Pages')}<Ic.Chevron size={13} /></button>}
          {!shut.pages && settings.pagesView === 'compact' && <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom><div className="tree-in cmp-list"><CompactList {...rowProps} roots={roots} /></div></HorizontalScroll>}
          {!shut.pages && settings.pagesView !== 'compact' && <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom><div className="tree-in">{roots.map((p) => <TreeRow key={p.id} {...rowProps} page={p} depth={0} />)}</div></HorizontalScroll>}
          {!shut.pages && roots.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}

          {tagList.length > 0 && (
            <SidebarTags tags={tagList} active={tagFilter} onPick={setTagFilter} shut={!!shut.tags} onToggle={() => setShut((x) => ({ ...x, tags: !x.tags }))} pages={taggedPages} currentId={current?.id} onOpen={setCurrentId} />
          )}

        </div>

        <SideTip />
        <div className="side-foot">
          <WorkspaceCard onOpen={() => setFolderOpen(true)} />
          <button className={'row plain' + (view === 'settings' ? ' cur' : '')} onClick={() => setView('settings')}>
            <span className="ic"><Ic.Settings /></span><span className="ntitle">{t('Settings')}</span>
          </button>
          <button className="row plain" onClick={() => setTrashOpen(true)}>
            <span className="ic"><Ic.Trash /></span><span className="ntitle">{t('Trash')}</span>
            {repo.trash().length > 0 && <span className="badge">{repo.trash().length}</span>}
          </button>
          <div className="ds-split side-new">
            <button className="ds-btn ds-btn--primary" onClick={() => add(null)}><Ic.Plus size={16} /><span className="ntitle">{t('New page')}</span></button>
            <button className="ds-btn ds-btn--primary" aria-label={t('More')} aria-expanded={!!newMenu} onClick={(e) => setNewMenu(newMenu ? null : e.currentTarget.parentElement!.getBoundingClientRect())}><Ic.Chevron size={14} /></button>
          </div>
          {newMenu && <Popover anchor={newMenu} onClose={() => setNewMenu(null)}><div className="ds-menu">
            <MenuItem icon={<Ic.Page />} label={t('New page')} onClick={() => (setNewMenu(null), add(null))} />
            <MenuItem icon={<Ic.Folder />} label={t('New folder')} onClick={() => (setNewMenu(null), addFolder(null))} />
            <MenuItem icon={<Ic.Pencil />} label={t('New board')} onClick={() => (setNewMenu(null), add(null, 'board'))} />
            <MenuItem icon={<Ic.Table />} label={t('New database')} onClick={() => (setNewMenu(null), addDatabase(null))} />
            <MenuItem icon={<Ic.Checklist />} label={t('New to-do list')} onClick={() => (setNewMenu(null), add(null, 'todo'))} />
          </div></Popover>}
          <div className="side-credit">{t('Created by')} Vexor</div>
        </div>
      </aside>

      <main ref={mainRef} className={'main' + (panelOpen && !reader && view === 'page' && current ? ' drawer-open' : '')}>
        <header className="topbar">
          {!sideOpen && <button className="icon-btn" title={t('Open sidebar  Ctrl+\\')} onClick={() => setSideOpen(true)}><Ic.Sidebar /></button>}
          <nav className="crumbs">
            <button className="crumb-home" title={t('Home')} onClick={() => setView('home')}><Ic.Home size={15} /></button>
            {view === 'home' && <span className="crumb"><span className="crumb-cur"><Ic.Sidebar size={14} />{t('Home')}</span></span>}
            {view === 'files' && <span className="crumb"><span className="crumb-cur"><Ic.Folders size={14} />{t('Files')}</span></span>}
            {view === 'tasks' && <span className="crumb"><span className="crumb-cur"><Ic.Checklist size={14} />{t('Tasks')}</span></span>}
            {view === 'databases' && <span className="crumb"><span className="crumb-cur"><Ic.Table size={14} />{t('Databases')}</span></span>}
            {view === 'drawings' && <span className="crumb"><span className="crumb-cur"><Ic.Pencil size={14} />{t('Drawings')}</span></span>}
            {view === 'settings' && <span className="crumb"><span className="crumb-cur"><Ic.Settings size={14} />{t('Settings')}</span></span>}
            {view === 'page' && crumbs.map((c, i) => (
              <span key={c.id} className={'crumb' + (i === crumbs.length - 1 ? ' last' : '')}>
                <span className="crumb-sep"><Ic.Chevron size={13} /></span>
                {c.kind === 'folder' ? (
                  <span className="crumb-folder" dir="auto"><Ic.Folder size={14} /><span>{c.title || t('Folder')}</span></span>
                ) : (
                  <button onClick={() => setCurrentId(c.id)} dir="auto">
                    <span className="ic">{iconNode(c.icon, 14)}</span><span className="crumb-t">{c.title || t('Untitled')}</span>
                  </button>
                )}
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <span className={'status' + (save === 'saving' ? ' busy' : '')}><i className="dot" />{save === 'saving' ? t('Saving…') : t('Saved')}</span>
          <div className="tb-group">
            {current && view === 'page' && (
              <>
                <button className="icon-btn" title={t('Reader mode  Ctrl+.')} onClick={() => setReader(true)}><Ic.Reader /></button>
                <button className={'icon-btn' + (current.favorite ? ' fav-on' : '')} title={t('Favorite')} onClick={() => fav(current.id)}><Ic.Star filled={current.favorite} /></button>
                <button className={'icon-btn panel-toggle' + (panelOpen ? ' active' : '')} title={t('Page side panel (quick actions & navigation)')} onClick={() => setPanelOpen((o) => !o)}><Ic.Panel /></button>
              </>
            )}
            <button className="icon-btn" title={dark ? t('Light mode') : t('Dark mode')} onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}>
              {dark ? <Ic.Sun /> : <Ic.Moon />}
            </button>
          </div>
          {current && view === 'page' && <button className="share-btn" title={t('Share & export')} onClick={(e) => setDataMenu(e.currentTarget.getBoundingClientRect())}><Ic.Share size={15} />{t('Share')}</button>}
        </header>

        {reader && view === 'page' && current && <ReaderBar cfg={readerCfg} onCfg={(c) => (setReaderCfg(c), setPreference('not.reader.cfg', JSON.stringify(c)))} onExit={() => setReader(false)} />}
        <div className="scroller">
          {view === 'home' ? (
            <Home pages={pages} onOpen={setCurrentId} onNew={() => add(null)} onFolder={() => addFolder(null)} onTable={() => setTableOpen(true)} onCards={() => setCardsOpen(true)} onSearch={() => setSearching(true)}
              onNewDatabase={() => addDatabase(null)} onNewBoard={() => add(null, 'board')} onNewList={() => add(null, 'todo')}
              onDatabases={() => setView('databases')} onDrawings={() => setView('drawings')} onTasks={() => setView('tasks')}
              onTemplates={() => setTplOpen(true)} onWorkspaces={isTauri ? () => setFolderOpen(true) : undefined} />
          ) : view === 'files' ? (
            <Explorer pages={pages} onOpen={setCurrentId} onChange={refresh} onToast={(msg, undo) => setToast({ msg, undo })} />
          ) : view === 'tasks' ? (
            <Tasks onOpen={setCurrentId} onNewList={() => add(null, 'todo')} />
          ) : view === 'databases' ? (
            <Databases onOpen={setCurrentId} onNew={() => addDatabase(null)} onDelete={del} />
          ) : view === 'drawings' ? (
            <Drawings onOpen={setCurrentId} onNew={() => add(null, 'board')} onDelete={delDrawing} />
          ) : view === 'settings' ? (
            <SettingsView data={{ importMarkdown: doImport, importVault: () => void doVault(), exportAll: doExportAll, backup: doBackup, restore: doRestore, autoBackup: () => setBackupOpen(true), workspaces: () => setFolderOpen(true) }} />
          ) : current?.dbHost ? (
            <Suspense fallback={<div className="page-skeleton" aria-busy="true" />}><DatabasePage key={current.id} page={current} onOpenPage={setCurrentId} onMeta={refresh} readOnly={reader} /></Suspense>
          ) : current?.kind === 'board' ? (
            <BoardView key={current.id} page={current} onSave={setSave} onMeta={refresh} readOnly={reader} />
          ) : current ? (
            <>
              {current.cover && <CoverBanner cover={current.cover} onChange={setCoverMenu} onRemove={() => setCover(undefined)} />}
              <div className={'page-cols' + (current.cover ? ' has-cover' : '')}>
                <PageView key={current.id} page={current} onSave={setSave} onMeta={refresh} onCover={setCoverMenu} readOnly={reader} />
              </div>
            </>
          ) : (
            <div className="blank">
              <div className="blank-ic"><Ic.Page size={40} /></div>
              <h2>{t('No page open')}</h2>
              <p>{t('Create a page or search with Ctrl+K.')}</p>
              <button className="primary" onClick={() => add(null)}>{t('New page')}</button>
            </div>
          )}
        </div>
        {view === 'page' && current && (
          <PagePanel
            open={panelOpen && !reader}
            page={current}
            pages={pages}
            onClose={() => setPanelOpen(false)}
            onOpen={setCurrentId}
            onNewSub={() => add(current.id)}
            onFav={() => fav(current.id)}
            onCover={setCoverMenu}
            onSearch={() => setSearching(true)}
            onExport={() => exportMd(current.id)}
            onSettings={() => setView('settings')}
          />
        )}
      </main>

      {menu && menuPage && (
        <Popover anchor={menu.rect} onClose={() => setMenu(null)} align="end">
          <div className="ds-menu">
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Open />} label={t('Open')} onClick={() => (setCurrentId(menu.id), setView('page'), setMenu(null))} />}
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Star filled={menuPage.favorite} />} label={menuPage.favorite ? t('Remove from favorites') : t('Add to favorites')} onClick={() => (fav(menu.id), setMenu(null))} />}
            <MenuSep />
            <MenuLabel>{t('Create')}</MenuLabel>
            <MenuItem icon={<Ic.Plus />} label={menuPage.kind === 'folder' ? t('Add page in this folder') : t('Add subpage')} onClick={() => (add(menu.id), setMenu(null))} />
            <MenuItem icon={<Ic.Folders />} label={t('Add folder')} onClick={() => (addFolder(menu.id), setMenu(null))} />
            <MenuItem icon={<Ic.Pencil />} label={t('Add board')} onClick={() => (add(menu.id, 'board'), setMenu(null))} />
            <MenuSep />
            <MenuLabel>{t('Organize')}</MenuLabel>
            <MenuItem icon={<Ic.Pencil />} label={t('Rename')} onClick={() => (rename(menu.id), setMenu(null))} />
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Copy />} label={t('Duplicate')} onClick={() => (duplicate(menu.id), setMenu(null))} />}
            <MenuItem icon={<Ic.Folder />} label={t('Move to folder')} onClick={() => (setMovingId(menu.id), setMenu(null))} />
            {menuPage.parentId && <MenuItem icon={<Ic.Up />} label={t('Move to top level')} onClick={() => (move(menu.id, null, null), setMenu(null))} />}
            <MenuItem icon={<Ic.Clipboard />} label={t('Copy title')} onClick={() => (void navigator.clipboard?.writeText(menuPage.title || ''), setMenu(null))} />
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Markdown />} label={t('Export Markdown')} onClick={() => (exportMd(menu.id), setMenu(null))} />}
            <MenuSep />
            <MenuItem danger icon={<Ic.Trash />} label={t('Delete')} hint="Delete" onClick={() => (del(menu.id), setMenu(null))} />
          </div>
        </Popover>
      )}

      {blankMenu && (
        <Popover anchor={blankMenu} onClose={() => setBlankMenu(null)}>
          <div className="ds-menu">
            <MenuItem icon={<Ic.Plus />} label={t('New page')} onClick={() => (add(null), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Folders />} label={t('New folder')} onClick={() => (addFolder(null), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Pencil />} label={t('New board')} onClick={() => (add(null, 'board'), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Table />} label={t('New database')} onClick={() => (addDatabase(null), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Checklist />} label={t('New to-do list')} onClick={() => (add(null, 'todo'), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Blocks />} label={t('New from template…')} onClick={() => (setTplOpen(true), setBlankMenu(null))} />
            <MenuSep />
            <MenuLabel>{t('Go to')}</MenuLabel>
            <MenuItem icon={<Ic.Home />} label={t('Home')} onClick={() => (setView('home'), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Folders />} label={t('Files')} onClick={() => (setView('files'), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Table />} label={t('Databases')} onClick={() => (setView('databases'), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Table />} label={t('Pages table')} onClick={() => (setTableOpen(true), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Cards />} label={t('Flashcards')} onClick={() => (setCardsOpen(true), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Link />} label={t('Graph view')} onClick={() => (setGraphOpen(true), setBlankMenu(null))} />
            <MenuSep />
            <MenuItem icon={<Ic.Upload />} label={t('Import Markdown files…')} onClick={() => (setBlankMenu(null), doImport())} />
            <MenuItem icon={<Ic.Trash />} label={t('Trash')} onClick={() => (setTrashOpen(true), setBlankMenu(null))} />
            <MenuItem icon={<Ic.Settings />} label={t('Settings')} onClick={() => (setView('settings'), setBlankMenu(null))} />
          </div>
        </Popover>
      )}

      {coverMenu && current && (
        <Popover anchor={coverMenu} onClose={() => setCoverMenu(null)}>
          <CoverPicker page={current} onPick={setCover} onClose={() => setCoverMenu(null)} />
        </Popover>
      )}


      {dataMenu && (
        <Popover anchor={dataMenu} onClose={() => setDataMenu(null)} align="end">
          <div className="ds-menu share-menu">
            {current && view === 'page' && (
              <>
                <MenuLabel>{t('Share this page')}</MenuLabel>
                <MenuItem icon={<Ic.Markdown />} label={t('Export Markdown')} desc={t('Download as a .md file')} onClick={() => (setDataMenu(null), exportMd(current.id))} />
                <MenuItem icon={<Ic.Pdf />} label={t('Print / PDF')} desc={t('Save as PDF or print')} onClick={() => (setDataMenu(null), printPage(current.title))} />
                <MenuItem icon={<Ic.Copy />} label={t('Copy as Markdown')} desc={t('Put it on the clipboard')} onClick={async () => { setDataMenu(null); await navigator.clipboard?.writeText(await pageToMarkdown(current)); setToast({ msg: t('Copied') }) }} />
              </>
            )}
          </div>
        </Popover>
      )}

      {folderOpen && <Vaults onClose={() => setFolderOpen(false)} onNew={(create) => setNaming({ title: t('New workspace'), label: t('Workspace name:'), initial: t('My notes'), action: t('Next'), onSubmit: (n) => void create(n.trim() || t('My notes')) })} />}
      {movingId && <div className="overlay" onMouseDown={() => setMovingId(null)}><div className="modal move-dialog" role="dialog" aria-modal="true" aria-label={t('Move to folder')} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setMovingId(null)}><div className="modal-head"><b>{t('Move to folder')}</b><button className="icon-btn" title={t('Close')} onClick={() => setMovingId(null)}><Ic.Close /></button></div><div className="modal-list"><button className="result" onClick={() => { move(movingId,null,null); setMovingId(null) }}><Ic.Book /><span>{t('Move to top level')}</span></button>{pages.filter((p) => { if(p.kind !== 'folder' || p.id === movingId) return false; let parent: Page | undefined = p; const seen = new Set<string>(); while(parent) { if(parent.id === movingId || seen.has(parent.id)) return false; seen.add(parent.id); parent = pages.find((x) => x.id === parent!.parentId) } return true }).map((p) => <button className="result" key={p.id} onClick={() => { move(movingId,p.id,null); setMovingId(null) }}><Ic.Folder /><span dir="auto">{p.title || t('Untitled folder')}</span></button>)}</div></div></div>}
      {backupOpen && <BackupSettings onClose={() => setBackupOpen(false)} />}
      {graphOpen && <GraphView currentId={current?.id} onOpen={setCurrentId} onClose={() => setGraphOpen(false)} />}
      {tableOpen && <PagesTable pages={pages} onOpen={setCurrentId} onStatus={setStatus} onClose={() => setTableOpen(false)} />}
      {tplOpen && <Templates onPick={addFromTemplate} onClose={() => setTplOpen(false)} />}
      {cardsOpen && <Flashcards pageId={view === 'page' ? current?.id : undefined} onOpenPage={(id) => (setCardsOpen(false), setCurrentId(id))} onClose={() => (setCardsOpen(false), window.dispatchEvent(new Event('cards-reviewed')))} />}

      {naming && <NameDialog {...naming} onClose={() => setNaming(null)} />}
      {trashOpen && (
        <TrashModal key={trashTick} items={repo.trash()} days={TRASH_DAYS} onRestore={restore} onPurge={purge} onEmpty={emptyTrash} onClose={() => setTrashOpen(false)} />
      )}
      <UpdateCenter />
      {toast && <Toast msg={toast.msg} action={toast.undo ? t('Undo') : undefined} onAction={toast.undo} onClose={() => setToast(null)} />}

      {searching && (
        <SearchModal
          pages={pages.filter((p) => p.kind !== 'folder')} search={searchPages} commands={commands} onOpen={setCurrentId} initialQuery={searchInit}
          onClose={() => (setSearching(false), setSearchInit(''))}
          onSaveSearch={(query) => setNaming({ title: t('Save this search'), label: t('Name:'), initial: query, action: t('Save'), onSubmit: (name) => saveSaved([...saved, { id: crypto.randomUUID(), name: name.trim() || query, query }]) })}
        />
      )}
    </div>
  )
}
