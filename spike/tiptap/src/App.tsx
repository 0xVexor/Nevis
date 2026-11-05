import { commandHint, commandMatches, EDITOR_COMMANDS, matchesSidebarShortcut } from './shortcutCommands'
import { cssVars } from './cssVars'
import { setPreference } from './preferenceEvents'
import { UpdateCenter } from './UpdateUI'
import { bindingHint, matches } from './shortcutBindings'
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { repo, gcFiles, TRASH_DAYS } from './store'
import type { Cover, Page, PageStatus } from './repo'
import { SETTINGS_TABS, SettingsView, type SettingsTab } from './SettingsPage'
import { updates } from './updates'
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
import { buildBackup, download, pageToMarkdown, takeRestored } from './backup'
import { exportAllZip } from './io'
import { PagesTable } from './PagesTable'
import { HorizontalScroll } from './HorizontalScroll'
import { Flashcards } from './Flashcards'
import { SidebarTags } from './SidebarTags'
import { Explorer } from './Explorer'
import { Templates, TEMPLATE_GLYPH, BOARD_TEMPLATE, DATABASE_TEMPLATE } from './TemplateGallery'
import { getTemplates } from './templates'
import { PageView, PICK_TAG, type SaveState } from './PageView'
import { buildIndex } from './pageIndex'
import { ReaderBar, loadReaderCfg, type ReaderCfg } from './ReaderBar'
import { Vaults } from './Vaults'
import { WorkspaceCard } from './VaultSwitcher'
import { GraphView } from './GraphView'
import { searchPages } from './searchIndex'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { saveBeforeUpdate } from './updateSave'
import { flushPreferences } from './sharedPreferences'
import { isTauri, kvGet, kvSet, pageFilePath, revealPageFile } from './db'
import { watchDueCards } from './cardsDue'
import { normalizeFa } from './normalize'
import { Brand } from './Brand'
import { BrandMark } from './BrandMark'
import { SaveStatus } from './design-system/SaveStatus'
import { WorkspaceHeader } from './design-system/WorkspaceHeader'
import { ResizeHandle } from './design-system/ResizeHandle'
import { Dialog, Icon, IconButton, Menu, Row, dirOf, Button, useMenu, type MenuItem as MenuSpec, NameDialog, Toast } from './design-system'
import { APP_TOAST, SearchModal, type PaletteCommand } from './ui'
import { Popover } from './design-system/Popover'
import { Home } from './Home'
import { Trash } from './Trash'
import { iconNode } from './iconSet'
import { printPage } from './print'
import { confirmDialog } from './dialog'
import { OPEN_PAGE, PAGES_CHANGED } from './editor/pageLink'
import { t } from './i18n'
import { isMac, shortcutHint, shortcutLabel } from './shortcuts'
import { CompactList, TreeRow } from './PageTree'

const revealKey = isMac() ? 'Reveal in Finder' : /Windows/i.test(navigator.userAgent) ? 'Show in Explorer' : 'Show in file manager'

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

const SIDE_MIN = 160
const SIDE_MAX = 600
const RAIL_MIN = 148
const RAIL_MAX = 320
type Panel = 'vault' | 'tasks' | 'settings'
const PANEL_TITLES = { vault: 'Navigation', tasks: 'Tasks', settings: 'Settings' } as const
const NARROW_WORKSPACE = '(max-width: 760px)'
const BIG_TREE = 150 // pages from which the sidebar tree starts collapsed

export default function App() {
  const [pages, setPages] = useState<Page[]>(() => repo.list())
  const [currentId, setCurrentIdRaw] = useState<string>(() => localStorage.getItem('not.current') || repo.pagesOnly()[0]?.id || '')
  const [view, setViewRaw] = useState<'home' | 'page' | 'settings' | 'tasks' | 'drawings' | 'databases' | 'files' | 'trash'>('home')
  // back / forward through the places visited (pages and views), each remembering how far it was scrolled
  const hist = useRef<{ view: string; id: string; scroll: number }[]>([])
  const hpos = useRef(-1)
  const goingTo = useRef<{ view: string; id: string } | null>(null)
  const [, bumpHist] = useState(0)
  const scrollerEl = () => document.querySelector<HTMLElement>('.scroller')
  const saveScroll = () => {
    const e = hist.current[hpos.current]
    const sc = scrollerEl()
    if (e && sc) e.scroll = sc.scrollTop
  }
  const setView = useCallback((v: Parameters<typeof setViewRaw>[0]) => (saveScroll(), setViewRaw(v)), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [panelOpen, setPanelOpen] = useState<boolean>(() => store('not.panel.v2', false))
  const [coverMenu, setCoverMenu] = useState<DOMRect | null>(null)
  // opening any page (sidebar, search, link, breadcrumb…) also leaves the settings view
  const setCurrentId = useCallback((id: string) => (saveScroll(), setViewRaw('page'), setCurrentIdRaw(id)), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const goal = goingTo.current
    if (goal && goal.view === view && goal.id === currentId) return // arrived by back / forward: already in the list
    goingTo.current = null
    const here = hist.current[hpos.current]
    if (here && here.view === view && here.id === currentId) return
    hist.current = [...hist.current.slice(0, hpos.current + 1), { view, id: currentId, scroll: 0 }].slice(-100)
    hpos.current = hist.current.length - 1
    bumpHist((n) => n + 1)
  }, [view, currentId])
  const goHist = useCallback((delta: number) => {
    const n = hpos.current + delta
    const to = hist.current[n]
    if (!to) return
    saveScroll()
    hpos.current = n
    goingTo.current = { view: to.view, id: to.id }
    setViewRaw(to.view as never)
    setCurrentIdRaw(to.id)
    bumpHist((k) => k + 1)
    // the page body mounts a moment after the switch: put the scroll back once it has its height
    for (const ms of [0, 60, 160, 320, 600])
      window.setTimeout(() => {
        const sc = scrollerEl()
        if (sc && hist.current[hpos.current] === to) sc.scrollTop = to.scroll
      }, ms)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const mouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault()
        if (e.type === 'mouseup') goHist(e.button === 3 ? -1 : 1)
      }
    }
    const key = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]')) {
        e.preventDefault()
        goHist((e.key === 'ArrowLeft') === (document.documentElement.dir !== 'rtl') ? -1 : 1)
      }
    }
    window.addEventListener('mouseup', mouse)
    window.addEventListener('auxclick', mouse)
    window.addEventListener('keydown', key)
    return () => (window.removeEventListener('mouseup', mouse), window.removeEventListener('auxclick', mouse), window.removeEventListener('keydown', key))
  }, [goHist])
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
  const [panelVisibility, setPanelVisibility] = useState(() => store<Record<Panel, boolean>>('not.contextPanels', { vault: store('not.side', true), tasks: true, settings: true }))
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WORKSPACE).matches)
  const [overlayPanel, setOverlayPanel] = useState<Panel | null>(null)
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null)
  const panelToggle = useRef<HTMLButtonElement>(null)
  const [cardsOpen, setCardsOpen] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const overlayOpen = cardsOpen || tplOpen || graphOpen || tableOpen
  const panel: Panel | null = overlayOpen
    ? null
    : view === 'home' || view === 'page'
      ? 'vault'
      : view === 'tasks' || view === 'settings'
        ? view
        : null
  const sideOpen = panel !== null && (narrow ? overlayPanel === panel : panelVisibility[panel])
  const setContextOpen = useCallback(
    (open: boolean) => {
      if (!panel) return
      if (narrow) setOverlayPanel(open ? panel : null)
      else setPanelVisibility((visibility) => ({ ...visibility, [panel]: open }))
    },
    [narrow, panel],
  )
  const toggleContext = useCallback(() => setContextOpen(!sideOpen), [setContextOpen, sideOpen])
  const hideContext = () => {
    setContextOpen(false)
    requestAnimationFrame(() => panelToggle.current?.focus())
  }
  const [sideW, setSideW] = useState<number | null>(() => store<number | null>('not.sideW', null)) // null: the width of the chosen sidebar style
  const [railWidth, setRailWidth] = useState<number | null>(() => store('not.navWidth', null))
  const [railPeek, setRailPeek] = useState(false)
  const [railPinned, setRailPinned] = useState(false)
  useEffect(() => put('not.navWidth', railWidth), [railWidth])
  useEffect(() => put('not.sideW', sideW), [sideW])
  const [searching, setSearching] = useState(false)
  const [writingCatalog, setWritingCatalog] = useState<typeof import('./editor/slash').editorSearchItems>()
  useEffect(() => {
    if (searching && !writingCatalog) void import('./editor/slash').then((module) => setWritingCatalog(() => module.editorSearchItems))
  }, [searching, writingCatalog])
  const [searchInit, setSearchInit] = useState('') // query to start the search with (a saved search)
  const [tagFilter, setTagFilter] = useState<string | null>(null) // sidebar: show only pages with this tag
  // a tag clicked on a page opens the sidebar's tag list on that tag
  useEffect(() => {
    const pick = (e: Event) => {
      setTagFilter(normalizeFa((e as CustomEvent<string>).detail))
      setShut((x) => ({ ...x, tags: false }))
      setPanelVisibility((visibility) => (visibility.vault ? visibility : { ...visibility, vault: true }))
      if (window.matchMedia(NARROW_WORKSPACE).matches) setOverlayPanel('vault')
      // the list sits low in the sidebar: bring it into view once it has rendered
      window.setTimeout(() => document.querySelector('.context-panel .tagres')?.scrollIntoView({ block: 'nearest' }), 60)
    }
    window.addEventListener(PICK_TAG, pick)
    return () => window.removeEventListener(PICK_TAG, pick)
  }, [])
  const [saved, setSaved] = useState<{ id: string; name: string; query: string }[]>([])
  useEffect(() => void kvGet<{ id: string; name: string; query: string }[]>('savedSearches').then((s) => setSaved(Array.isArray(s) ? s : [])), [])
  const saveSaved = (next: { id: string; name: string; query: string }[]) => (setSaved(next), void kvSet('savedSearches', next))
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null)
  // dragging a page from the tree shows a Favorites drop zone, so a page can be pinned by dropping it there
  const [dragPage, setDragPage] = useState(false)
  const [favOver, setFavOver] = useState(false)
  useEffect(() => {
    // deferred: changing the DOM inside dragstart makes the browser cancel the drag
    const start = (e: DragEvent) => {
      const on = !!(e.target as HTMLElement | null)?.closest?.('.row.tree')
      window.setTimeout(() => setDragPage(on), 0)
    }
    const end = () => (setDragPage(false), setFavOver(false))
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => (window.removeEventListener('dragstart', start), window.removeEventListener('dragend', end), window.removeEventListener('drop', end))
  }, [])
  const [naming, setNaming] = useState<{ title: string; label: string; initial: string; action: string; onSubmit: (name: string) => void } | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>() // the tab a command asked for; only while the settings are open
  useEffect(() => {
    if (view !== 'settings') setSettingsTab(undefined)
  }, [view])
  const [folderOpen, setFolderOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: () => void; action?: { label: string; run: () => void } } | null>(null)
  const [dueCards, setDueCards] = useState(0)
  useEffect(() => watchDueCards(setDueCards, isTauri), [])
  const { open: openShare, menu: shareMenu } = useMenu()
  const [blankMenu, setBlankMenu] = useState<DOMRect | null>(null) // right-click on empty sidebar space
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [reader, setReader] = useState(false)
  const { open: openCrumbs, menu: crumbsMenu } = useMenu()
  // full screen for the whole app, from any view: the desktop window itself, or the browser's full screen
  const [fullScreen, setFullScreen] = useState(false)
  const toggleFullScreen = useCallback(async () => {
    try {
      if (isTauri) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const next = !(await win.isFullscreen())
        await win.setFullscreen(next)
        setFullScreen(next)
      } else if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      /* the platform refused; nothing changes */
    }
  }, [])
  useEffect(() => {
    const sync = () => !isTauri && setFullScreen(!!document.fullscreenElement)
    const key = (e: KeyboardEvent) => {
      if (!commandMatches(e, 'Full screen')) return
      e.preventDefault()
      void toggleFullScreen()
    }
    document.addEventListener('fullscreenchange', sync)
    window.addEventListener('keydown', key)
    return () => (document.removeEventListener('fullscreenchange', sync), window.removeEventListener('keydown', key))
  }, [toggleFullScreen])
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
  useEffect(() => put('not.contextPanels', panelVisibility), [panelVisibility])
  useEffect(() => setOverlayPanel(null), [panel])
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
  useEffect(() => {
    const query = window.matchMedia(NARROW_WORKSPACE)
    const change = (event: MediaQueryListEvent) => {
      setNarrow(event.matches)
      setOverlayPanel(null)
    }
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!narrow || !sideOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('.ds-pop, [role="dialog"]')) return
      setOverlayPanel(null)
      requestAnimationFrame(() => panelToggle.current?.focus())
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [narrow, sideOpen])
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
    // screens report their own changes here: { msg, undo?, action? } (see APP_TOAST in ui.tsx)
    const screenToast = (e: Event) => setToast((e as CustomEvent<{ msg: string; undo?: () => void; action?: { label: string; run: () => void } }>).detail)
    window.addEventListener('layout-message', layoutNotice)
    window.addEventListener(APP_TOAST, screenToast)
    window.addEventListener('page-conflict', kept)
    window.addEventListener('storage-error', storageError)
    return () => {
      window.removeEventListener(OPEN_PAGE, open)
      window.removeEventListener(PAGES_CHANGED, changed)
      window.removeEventListener('external-change', changed)
      window.removeEventListener('layout-message', layoutNotice)
      window.removeEventListener(APP_TOAST, screenToast)
      window.removeEventListener('page-conflict', kept)
      window.removeEventListener('storage-error', storageError)
    }
  }, [refresh])
  // Ctrl+Z (Cmd+Z) undoes what the open toast offers to undo, unless the focus is in something that has its own undo (text, the editor)
  useEffect(() => {
    if (!toast?.undo) return
    const undo = toast.undo
    const key = (e: KeyboardEvent) => {
      const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.matches('input, textarea, select'))
      if (editable || !commandMatches(e, 'Undo')) return
      e.preventDefault()
      undo()
      setToast(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toast])
  useEffect(() => {
    if (!panel) return
    const key = (event: KeyboardEvent) => {
      if (matchesSidebarShortcut(event)) {
        event.preventDefault()
        toggleContext()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [panel, toggleContext])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Alt + = / Alt + -: wider / narrower text column (in reader mode: the reader page)
      const wider = matches(e, 'widerColumn')
      if (wider || matches(e, 'narrowerColumn')) {
        e.preventDefault()
        const d = wider ? PAGE_W.step : -PAGE_W.step
        if (readerRef.current)
          setReaderCfg((c) => {
            const n = { ...c, width: Math.min(1400, Math.max(480, c.width + d)) }
            setPreference('not.reader.cfg', JSON.stringify(n))
            return n
          })
        else
          setPageW((w) => {
            const n = Math.min(PAGE_W.max, Math.max(PAGE_W.min, w + d))
            setPreference('not.page.width', String(n))
            return n
          })
      }
      if (matches(e, 'reader')) (e.preventDefault(), setReader((r) => !r)) // physical key: works with the Persian layout
      if (commandMatches(e, 'Leave reader mode') && !document.querySelector('.lightbox, .palette-overlay')) setReader(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  // Ctrl/Cmd+K opens search from anywhere in the app: capture phase (the editor cannot swallow it) and the physical key
  // (so it also works with the Persian keyboard layout, where e.key is not “k”)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (matches(e, 'search')) {
        e.preventDefault()
        e.stopPropagation()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const addDatabase = (parentId: string | null) => {
    void import('./database/runtime')
      .then((m) => m.getDatabase())
      .then((svc) => svc.one<{ hostPageId: string }>('database.create', { parentPageId: parentId, title: t('Untitled database') }))
      .then((r) => {
        if (parentId) expand(parentId)
        refresh()
        setCurrentId(r.hostPageId)
      })
      .catch((e) => setToast({ msg: String(e?.message ?? e) }))
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
  const trashed = repo.trash()
  const closeOverlays = useCallback(() => {
    setCardsOpen(false)
    setTplOpen(false)
    setGraphOpen(false)
    setTableOpen(false)
  }, [])
  // Flashcards and Templates are pages: going to another page or view (search, links, the sidebar) leaves them
  useEffect(() => (setCardsOpen(false), setTplOpen(false), setGraphOpen(false), setTableOpen(false)), [view, currentId])
  const addFromTemplate = (id: string) => {
    setTplOpen(false)
    if (id === BOARD_TEMPLATE) return add(null, 'board')
    if (id === DATABASE_TEMPLATE) return addDatabase(null)
    const p = repo.create(null, id === 'todo' ? 'todo' : 'page')
    const tp = getTemplates().find((x) => x.id === id)
    if (tp) {
      repo.update(p.id, { title: tp.pageTitle, icon: 'i:' + (TEMPLATE_GLYPH[tp.id] ?? 'page') })
      window.__pendingTpl = { pageId: p.id, id }
    }
    refresh()
    setView('page')
    setCurrentId(p.id)
  }
  const addFolder = (parentId: string | null) =>
    setNaming({
      title: t('New folder'),
      label: t('Folder name:'),
      initial: t('New folder'),
      action: t('Create'),
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
    repo.update(
      c.id,
      {
        title: p.title ? p.title + ' ' + t('(copy)') : '',
        icon: p.icon,
        cover: p.cover,
        titleDir: p.titleDir,
        tags: p.tags ? [...p.tags] : undefined,
        status: p.status,
        content: structuredClone(p.content),
      },
      { copyContent: true },
    )
    refresh()
    if (p.kind !== 'folder') setCurrentId(c.id)
  }
  const purge = async (p: Page) => {
    if (
      !(await confirmDialog({
        title: t('Delete permanently'),
        message: t('“{title}” will be deleted permanently. This cannot be undone.', { title: p.title || t('Untitled') }),
        confirmLabel: t('Delete permanently'),
        danger: true,
      }))
    )
      return
    repo.purge(p.id)
    await gcFiles()
    refresh()
  }
  const emptyTrash = async () => {
    if (!(await confirmDialog({ title: t('Empty trash'), message: t('Permanently delete everything in the trash? This cannot be undone.'), confirmLabel: t('Empty trash'), danger: true }))) return
    repo.emptyTrash()
    await gcFiles()
    refresh()
  }
  const restore = (id: string) => {
    repo.restoreFromTrash(id)
    refresh()
    if (repo.get(id)?.kind !== 'folder') setCurrentId(id)
  }
  const fav = (id: string) => {
    const p = repo.get(id)
    if (p) repo.update(id, { favorite: !p.favorite })
    refresh()
  }
  // state updaters must be pure (React StrictMode runs them twice): copy the set instead of mutating it
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const expand = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
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
      await saveBeforeUpdate()
      await repo.flushBeforeUpdate()
      await flushPreferences()
      const path = await saveDialog({ defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (path) await invoke('vault_backup_save', { path })
    } catch (error) {
      setToast({ msg: t('Backup failed') + ': ' + String(error) })
    }
  }
  useEffect(() => {
    const r = takeRestored()
    if (r?.merged)
      setToast({
        msg: t('Merged: {added} new pages, {updated} updated, {kept} kept as they were. Your notes before were saved as {copy}.', {
          added: r.merged.added,
          updated: r.merged.updated,
          kept: r.merged.kept,
          copy: r.copy ?? '',
        }),
      })
    else if (r)
      setToast({
        msg: r.copy
          ? t('{pages} pages and {files} files restored. Your previous notes were saved as {copy}.', { pages: r.pages, files: r.files, copy: r.copy })
          : t('{pages} pages and {files} files restored', { pages: r.pages, files: r.files }),
      })
  }, [])
  const openSettings = useCallback((tab?: SettingsTab) => {
    closeOverlays()
    setSettingsTab(tab)
    setView('settings')
  }, [closeOverlays, setView])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.repeat || !commandMatches(event, 'Open Settings')) return
      event.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [openSettings])
  const openData = () => openSettings('data')
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
  const setStatus = (id: string, status: PageStatus | undefined) => {
    repo.update(id, { status })
    refresh()
  }
  const exportMd = async (id: string) => {
    const p = repo.get(id)
    if (p) download((p.title || 'page') + '.md', new Blob([await pageToMarkdown(p)], { type: 'text/markdown' }))
  }
  const copied = (text: string) => navigator.clipboard?.writeText(text).then(() => setToast({ msg: t('Copied') }))
  const copyPath = (id: string) => void pageFilePath(id).then(copied).catch(() => setToast({ msg: t('Could not read the page path') }))
  const revealFile = (id: string) => void revealPageFile(id).catch(() => setToast({ msg: t('Could not open the folder') }))
  const shareItems = (page: Page): MenuSpec[] => [
    { kind: 'head', label: 'Export' },
    { label: 'Markdown file', hint: '.md', icon: <Icon name="download" />, onSelect: () => void exportMd(page.id) },
    { label: 'PDF or print', icon: <Icon name="printer" />, onSelect: () => printPage(page.title) },
    { kind: 'sep' },
    { kind: 'head', label: 'Copy' },
    {
      label: 'Copy as Markdown',
      icon: <Icon name="copy" />,
      onSelect: () => void pageToMarkdown(page).then(copied),
    },
    ...(isTauri
      ? ([
          { label: 'Copy path', icon: <Icon name="link" />, onSelect: () => copyPath(page.id) },
          { label: revealKey, icon: <Icon name="folder" />, onSelect: () => revealFile(page.id) },
        ] satisfies MenuSpec[])
      : []),
    { kind: 'sep' },
    { label: 'Export the whole workspace', hint: '.zip', icon: <Icon name="vault" />, onSelect: () => void doExportAll() },
  ]
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
    for (const p of pages)
      if (p.kind !== 'folder')
        for (const tg of p.tags ?? []) {
          const key = normalizeFa(tg)
          const g = m.get(key)
          g ? g.count++ : m.set(key, { key, label: tg, count: 1 })
        }
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fa'))
  }, [pages])
  const taggedPages = useMemo(() => (tagFilter ? pages.filter((p) => p.kind !== 'folder' && p.tags?.some((tg) => normalizeFa(tg) === tagFilter)) : []), [pages, tagFilter])
  const crumbs = useMemo(() => {
    const out: Page[] = []
    for (let p: Page | undefined = current; p; p = p.parentId ? pages.find((x) => x.id === p!.parentId) : undefined) out.unshift(p)
    return out
  }, [current, pages])
  const writingCommandsAvailable = current && view === 'page' && !overlayOpen && !reader && (!current.kind || current.kind === 'todo')
  const commands: PaletteCommand[] = ([
    { id: 'new-page', label: t('New page'), icon: <Icon name="file" size={16} />, keywords: 'create add صفحه جدید', run: () => add(null) },
    { id: 'templates', label: t('Templates'), icon: <Icon name="blocks" size={16} />, keywords: 'template قالب تمپلیت', run: () => (closeOverlays(), setTplOpen(true)) },
    { id: 'new-folder', label: t('New folder'), icon: <Icon name="folder" size={16} />, keywords: 'create add پوشه', run: () => addFolder(null) },
    {
      id: 'compact-pages',
      label: settings.pagesView === 'compact' ? t('Show pages as a tree') : t('Show pages as a compact list'),
      icon: <Icon name="layers" size={16} />,
      keywords: 'compact flat list tree pages sidebar intellij فشرده لیست درخت صفحه',
      run: () => updateSettings({ pagesView: settings.pagesView === 'compact' ? 'tree' : 'compact' }),
    },
    { id: 'new-todo', label: t('New to-do list'), icon: <Icon name="checklist" size={16} />, keywords: 'create add todo task list checklist لیست کار تسک چک‌لیست جدید', run: () => add(null, 'todo') },
    { id: 'new-database', label: t('New database'), icon: <Icon name="table" size={16} />, keywords: 'create add table database board calendar پایگاه داده جدول جدید', run: () => addDatabase(null) },
    { id: 'new-board', label: t('New board'), icon: <Icon name="pencil" size={16} />, keywords: 'create add whiteboard drawing canvas sketch بوم نقاشی طراحی جدید', run: () => add(null, 'board') },
    ...(current && view === 'page'
      ? [
          { id: 'subpage', label: t('Add subpage'), icon: <Icon name="plus" size={16} />, keywords: 'زیرصفحه', run: () => add(current.id) },
          {
            id: 'fav',
            label: current.favorite ? t('Remove from favorites') : t('Add to favorites'),
            icon: <Icon name="star" size={16} />,
            keywords: 'star pin علاقه‌مندی',
            run: () => fav(current.id),
          },
          { id: 'reader', label: t(reader ? 'Leave reader mode' : 'Reader mode'), icon: <Icon name="bookopen" size={16} />, keywords: 'read مطالعه', hint: reader ? commandHint('Leave reader mode') : bindingHint('reader'), run: () => setReader(open => !open) },
          {
            id: 'find',
            label: t('Find in page'),
            icon: <Icon name="search" size={16} />,
            keywords: 'search ctrl+f جست‌وجو پیدا',
            hint: bindingHint('find'),
            run: () => window.setTimeout(() => window.dispatchEvent(new Event('open-find')), 0),
          },
          {
            id: 'history',
            label: t('Version history'),
            icon: <Icon name="history" size={16} />,
            keywords: 'versions restore earlier تاریخچه نسخه',
            run: () => window.setTimeout(() => window.dispatchEvent(new Event('open-history')), 0),
          },
          { id: 'export-md', label: t('Export Markdown'), icon: <Icon name="markdown" size={16} />, keywords: 'download خروجی', run: () => exportMd(current.id) },
          { id: 'print', label: t('Print / PDF'), icon: <Icon name="file-pdf" size={16} />, keywords: 'pdf print چاپ', run: () => printPage(current.title) },
        ]
      : []),
    ...(writingCommandsAvailable ? EDITOR_COMMANDS.filter(label => !['Heading 1', 'Heading 2', 'Heading 3', 'Link to page', 'Bulleted list', 'Numbered list', 'Checklist', 'Quote', 'Code block'].includes(label)).map(label => ({
      id: 'format-' + label,
      group: 'Writing',
      label: t(label),
      keywords: label + ' formatting editor',
      hint: commandHint(label),
      icon: <Icon name="pencil" size={16} />,
      run: () => window.setTimeout(() => window.dispatchEvent(new CustomEvent('run-editor-command', { detail: label })), 0),
    })) : []),
    ...(writingCommandsAvailable && writingCatalog ? writingCatalog().map(({ item, title, desc, searchOnly }) => ({
      id: 'editor-' + item.title + (item.vars?.name ?? ''),
      searchOnly,
      group: 'Writing',
      label: title,
      keywords: item.title + ' ' + item.keywords + ' ' + desc,
      icon: <Icon name="pencil" size={16} />,
      run: () => window.setTimeout(() => window.dispatchEvent(new CustomEvent('run-editor-command', { detail: item })), 0),
    })) : []),
    { id: 'fullscreen', label: t(fullScreen ? 'Exit full screen' : 'Full screen'), icon: <Icon name="maximize" size={16} />, keywords: 'fullscreen F11', hint: commandHint('Full screen'), run: () => void toggleFullScreen() },
    ...(current && view === 'page' ? [
      { id: 'rename-page', label: t('Rename'), icon: <Icon name="pencil" size={16} />, keywords: 'rename page title', run: () => rename(current.id) },
      { id: 'duplicate-page', label: t('Duplicate'), icon: <Icon name="copy" size={16} />, keywords: 'duplicate page copy', run: () => duplicate(current.id) },
      { id: 'delete-page', label: t('Delete'), icon: <Icon name="trash" size={16} />, keywords: 'delete move page to trash', run: () => del(current.id) },
      { id: 'move-page', label: t('Move to folder'), icon: <Icon name="folder" size={16} />, keywords: 'move page folder', run: () => setMovingId(current.id) },
      { id: 'page-panel', label: t('Page side panel (quick actions & navigation)'), icon: <Icon name="panel-left" size={16} />, keywords: 'page panel outline backlinks', run: () => setPanelOpen(open => !open) },
      ...shareItems(current).flatMap((item, index) => 'onSelect' in item && item.onSelect && item.label !== 'Markdown file' && item.label !== 'PDF or print' && item.label !== 'Export the whole workspace'
        ? [{ id: 'share-' + index, label: t(item.label), keywords: item.label, icon: item.icon ?? <Icon name="share" size={16} />, run: () => item.onSelect?.() }]
        : []),
    ] : []),
    { id: 'home', label: t('Home'), icon: <Icon name="home" size={16} />, keywords: 'dashboard خانه', run: () => (closeOverlays(), setView('home')) },
    { id: 'table', label: t('All pages'), icon: <Icon name="table" size={16} />, keywords: 'database جدول', run: () => (closeOverlays(), setTableOpen(true)) },
    { id: 'graph', label: t('Graph'), icon: <Icon name="link" size={16} />, keywords: 'graph links map backlinks گراف نقشه ارتباط پیوند', run: () => (closeOverlays(), setGraphOpen(true)) },
    { id: 'files', label: t('Files'), icon: <Icon name="folder-plus" size={16} />, keywords: 'files explorer folders manage فایل مدیریت پوشه فایل‌ها', run: () => (closeOverlays(), setView('files')) },
    { id: 'tasks', label: t('Tasks'), icon: <Icon name="checklist" size={16} />, keywords: 'tasks todo checklist کارها وظایف چک لیست', run: () => (closeOverlays(), setView('tasks')) },
    { id: 'databases', label: t('Databases'), icon: <Icon name="table" size={16} />, keywords: 'databases tables projects all database پایگاه داده دیتابیس پروژه جدول', run: () => (closeOverlays(), setView('databases')) },
    { id: 'drawings', label: t('Drawings'), icon: <Icon name="pencil" size={16} />, keywords: 'drawings boards whiteboard sketch canvas excalidraw نقاشی بوم طراحی ترسیم', run: () => (closeOverlays(), setView('drawings')) },
    { id: 'cards', label: t('Flashcards'), icon: <Icon name="cards" size={16} />, keywords: 'review srs فلش‌کارت', run: () => (closeOverlays(), setCardsOpen(true)) },
    { id: 'trash', label: t('Trash'), icon: <Icon name="trash" size={16} />, keywords: 'deleted سطل', run: () => (closeOverlays(), setView('trash')) },
    {
      id: 'theme',
      label: dark ? t('Light mode') : t('Dark mode'),
      icon: dark ? <Icon name="sun" size={16} /> : <Icon name="moon" size={16} />,
      keywords: 'theme dark light تم',
      run: () => updateSettings({ theme: dark ? 'light' : 'dark' }),
    },
    ...(panel ? [{
      id: 'sidebar',
      label: sideOpen ? t('Hide side panel') : t('Show side panel'),
      icon: <Icon name="panel-left" size={16} />,
      keywords: 'side panel نوار کناری',
      hint: commandHint('Open or close the sidebar'),
      run: toggleContext,
    }] : []),
    { id: 'import', label: t('Import or restore…'), icon: <Icon name="upload" size={16} />, keywords: 'وارد کردن بازیابی markdown obsidian restore zip', run: openData },
    { id: 'restore', label: t('Restore from backup'), icon: <Icon name="upload" size={16} />, keywords: 'backup restore desktop workspace بازیابی پشتیبان بکاپ', run: openData },
    { id: 'export-all', label: t('Export all pages (zip with Markdown & images)'), icon: <Icon name="download" size={16} />, keywords: 'zip', run: doExportAll },
    { id: 'backup', label: t('Full backup (JSON)'), icon: <Icon name="save" size={16} />, keywords: 'پشتیبان', run: doBackup },
    ...[{ id: 'data-folder', label: t('Workspaces…'), icon: <Icon name="folder" size={16} />, keywords: 'vault switch workspace پوشه داده', run: () => setFolderOpen(true) }],
    { id: 'auto-backup', label: t('Automatic backup to folder…'), icon: <Icon name="save" size={16} />, keywords: 'پشتیبان خودکار', run: openData },
    { id: 'check-updates', label: t('Check for updates'), icon: <Icon name="download" size={16} />, keywords: 'update version beta release upgrade به‌روزرسانی نسخه', run: () => void updates.check(true) },
    { id: 'settings', label: t('Settings'), hint: commandHint('Open Settings'), icon: <Icon name="settings" size={16} />, keywords: 'preferences تنظیمات', run: () => openSettings() },
    // every page of the settings, one command each: "Settings › Shortcuts", "Settings › Data & backup"…
    ...SETTINGS_TABS.map((x) => ({ id: 'settings-' + x.id, label: t('Settings') + ' › ' + t(x.label), icon: x.icon, keywords: x.id + ' ' + x.hint + ' ' + t(x.hint), run: () => openSettings(x.id) })),
  ] satisfies PaletteCommand[]).map(command => {
    if ('group' in command && command.group) return command
    const id = command.id
    const group = id.startsWith('settings') || ['theme', 'sidebar', 'compact-pages', 'check-updates', 'fullscreen'].includes(id)
      ? 'Settings'
      : id.startsWith('new-') || id === 'subpage'
        ? 'Create'
        : ['import', 'restore', 'export-all', 'backup', 'data-folder', 'auto-backup'].includes(id)
          ? 'Data & backup'
          : ['home', 'templates', 'table', 'graph', 'files', 'tasks', 'databases', 'drawings', 'cards', 'trash'].includes(id)
            ? 'Workspace'
            : 'Page actions'
    return { ...command, group }
  })
  const menuPage = menu ? pages.find((p) => p.id === menu.id) : undefined

  const treePanel = useRef<HTMLDivElement>(null)
  const [reveal, setReveal] = useState<{ id: string } | null>(null)
  const revealActiveNote = () => {
    if (!current || view !== 'page' || current.database) return
    const byId = new Map(pages.map((page) => [page.id, page]))
    const ancestors = new Set<string>()
    for (let id = current.parentId; id && !ancestors.has(id); id = byId.get(id)?.parentId ?? null) ancestors.add(id)
    setCollapsed((previous) => new Set([...previous].filter((id) => !ancestors.has(id))))
    setShut((previous) => ({ ...previous, pages: false }))
    setReveal({ id: current.id })
  }
  useEffect(() => {
    if (!reveal) return
    treePanel.current?.querySelector<HTMLElement>(`[data-tree-page="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [reveal])
  const iconsOnly = settings.sidebar === 'icons' || narrow
  const railExpanded = iconsOnly && (railPeek || railPinned || !!newMenu)
  const railToggleLabel = t(railPinned ? 'Unpin sidebar' : 'Pin sidebar')
  const railPanelLabel = t(sideOpen ? 'Hide side panel' : 'Show side panel') + '  ' + commandHint('Open or close the sidebar')
  const sidePanelButton = panel && (
    <IconButton ref={panelToggle} label={railPanelLabel} aria-expanded={sideOpen} aria-controls="workspace-context" onClick={() => {
      toggleContext()
      requestAnimationFrame(() => panelToggle.current?.focus())
    }}>
      <Icon name="panel-left" size={17} className="ds-flip" />
    </IconButton>
  )
  const defaultRailWidth = settings.sidebar === 'compact' ? 148 : 176
  const preferencesOpen = view === 'settings'
  const rowProps = { index, currentId: current?.id ?? '', collapsed, onToggle: toggle, onOpen: setCurrentId, onAdd: add, onMenu: (id: string, rect: DOMRect) => setMenu({ id, rect }), onMove: move }

  return (
    <div
      data-preferences={preferencesOpen ? '' : undefined}
      className={'app' + (reader && view === 'page' && current ? ' reading' : '')}
      style={cssVars({ '--page-w': pageW + 'px', '--r-scale': readerCfg.scale, '--r-width': readerCfg.width + 'px' })}
    >
      <nav
        className="side"
        aria-label={t('Workspace navigation')}
        data-icons={iconsOnly && !railExpanded ? '' : undefined}
        data-expanded={railExpanded ? '' : undefined}
        style={railWidth ? cssVars({ '--nav-user-width': railWidth + 'px' }) : undefined}
        onPointerLeave={() => setRailPeek(false)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setRailPeek(false)
        }}
      >
        {!narrow && (!iconsOnly || railExpanded) && (
          <ResizeHandle label={t('Resize navigation rail')} width={railWidth ?? defaultRailWidth} min={RAIL_MIN} max={RAIL_MAX} onResize={setRailWidth} />
        )}
        <div className="ws">
          <WorkspaceHeader
            mark={<BrandMark />}
            name={<Brand />}
            revealLabel={railToggleLabel}
            expanded={!iconsOnly || railExpanded}
            pressed={iconsOnly ? railPinned : undefined}
            onReveal={iconsOnly ? () => setRailPeek(true) : undefined}
            onActivate={() => {
              setRailPinned(!railPinned)
              setRailPeek(!railPinned)
            }}
            action={!sideOpen && sidePanelButton}
          />
        </div>
        <div className="side-scroll">
          <button aria-label={t('Search')} className="row plain search-row" onClick={() => setSearching(true)}>
            <span className="ic">
              <Icon name="search" />
            </span>
            <span className="ntitle">{t('Search')}...</span>
            <kbd dir="ltr">{bindingHint('search')}</kbd>
          </button>

          <button aria-label={t('Home')} className={'row plain' + (view === 'home' && !overlayOpen ? ' cur' : '')} onClick={() => (closeOverlays(), setView('home'))}>
            <span className="ic">
              <Icon name="home" />
            </span>
            <span className="ntitle">{t('Home')}</span>
          </button>

          <button aria-label={t('Templates')} className={'row plain' + (tplOpen ? ' cur' : '')} onClick={() => (setCardsOpen(false), setGraphOpen(false), setTableOpen(false), setTplOpen(true))}>
            <span className="ic">
              <Icon name="templates" />
            </span>
            <span className="ntitle">{t('Templates')}</span>
          </button>

          <button aria-label={t('Tasks')} className={'row plain' + (view === 'tasks' && !overlayOpen ? ' cur' : '')} onClick={() => (closeOverlays(), setView('tasks'))}>
            <span className="ic">
              <Icon name="tasks" />
            </span>
            <span className="ntitle">{t('Tasks')}</span>
          </button>

          <button
            aria-label={t('Flashcards')}
            className={'row plain' + (cardsOpen && !tplOpen && !graphOpen && !tableOpen ? ' cur' : '')}
            onClick={() => (setTplOpen(false), setGraphOpen(false), setTableOpen(false), setCardsOpen(true))}
          >
            <span className="ic">
              <Icon name="cards" />
            </span>
            <span className="ntitle">{t('Flashcards')}</span>
            {dueCards > 0 && <span className="ds-badge">{dueCards}</span>}
          </button>

          <button aria-label={t('Databases')} className={'row plain' + (view === 'databases' && !overlayOpen ? ' cur' : '')} onClick={() => (closeOverlays(), setView('databases'))}>
            <span className="ic">
              <Icon name="database" />
            </span>
            <span className="ntitle">{t('Databases')}</span>
          </button>

          <button
            aria-label={t('Drawings')}
            className={'row plain' + (view === 'drawings' && !overlayOpen ? ' cur' : '')}
            onPointerEnter={warmDrawing}
            onClick={() => (closeOverlays(), setView('drawings'))}
          >
            <span className="ic">
              <Icon name="pencil" />
            </span>
            <span className="ntitle">{t('Drawings')}</span>
          </button>

          <button aria-label={t('Graph')} className={'row plain' + (graphOpen ? ' cur' : '')} onClick={() => (setCardsOpen(false), setTplOpen(false), setTableOpen(false), setGraphOpen(true))}>
            <span className="ic">
              <Icon name="graph" />
            </span>
            <span className="ntitle">{t('Graph')}</span>
          </button>

          <button aria-label={t('All pages')} className={'row plain' + (tableOpen ? ' cur' : '')} onClick={() => (setCardsOpen(false), setTplOpen(false), setGraphOpen(false), setTableOpen(true))}>
            <span className="ic">
              <Icon name="table" />
            </span>
            <span className="ntitle">{t('All pages')}</span>
          </button>
        </div>
        <SideTip />
        <div className="side-foot">
          <button aria-label={t('Settings')} className={'row plain' + (view === 'settings' ? ' cur' : '')} onClick={() => (closeOverlays(), setView('settings'))}>
            <span className="ic">
              <Icon name="settings" />
            </span>
            <span className="ntitle">{t('Settings')}</span>
          </button>
          <button aria-label={t('Files')} className={'row plain' + (view === 'files' && !overlayOpen ? ' cur' : '')} onClick={() => (closeOverlays(), setView('files'))}>
            <span className="ic">
              <Icon name="paperclip" />
            </span>
            <span className="ntitle">{t('Files')}</span>
          </button>
          <button aria-label={t('Trash')} className={'row plain' + (view === 'trash' && !overlayOpen ? ' cur' : '')} onClick={() => (closeOverlays(), setView('trash'))}>
            <span className="ic">
              <Icon name="trash" />
            </span>
            <span className="ntitle">{t('Trash')}</span>
            {trashed.length > 0 && <span className="ds-badge">{trashed.length}</span>}
          </button>
          <Button
            variant="primary"
            className="side-new"
            aria-label={t('New')}
            aria-haspopup="menu"
            aria-expanded={!!newMenu}
            onClick={(event) => setNewMenu(newMenu ? null : event.currentTarget.getBoundingClientRect())}
          >
            <Icon name="plus" size={16} />
            <span className="ntitle">{t('New')}</span>
          </Button>
          {newMenu && (
            <Menu
              anchor={newMenu}
              onClose={() => setNewMenu(null)}
              items={[
                { label: t('New page'), icon: <Icon name="file" size={16} />, onSelect: () => add(null) },
                { label: t('New folder'), icon: <Icon name="folder" size={16} />, onSelect: () => addFolder(null) },
                { label: t('New board'), icon: <Icon name="pencil" size={16} />, onSelect: () => add(null, 'board') },
                { label: t('New database'), icon: <Icon name="table" size={16} />, onSelect: () => addDatabase(null) },
                { label: t('New to-do list'), icon: <Icon name="checklist" size={16} />, onSelect: () => add(null, 'todo') },
              ]}
            />
          )}
          <div className="side-workspace">
            <WorkspaceCard onOpen={() => setFolderOpen(true)} />
          </div>
          <div className="side-credit">{t('Created by')} Vexor</div>
        </div>
      </nav>

      {panel && (
        <>
          {narrow && sideOpen && <div className="context-backdrop" aria-hidden="true" onClick={hideContext} />}
          <aside
            id="workspace-context"
            className="context-panel"
            aria-label={t(PANEL_TITLES[panel])}
            hidden={!sideOpen}
            style={sideW ? cssVars({ '--side-w': sideW + 'px' }) : undefined}
            onContextMenu={
              panel === 'vault'
                ? (event) => {
                    event.preventDefault()
                    setBlankMenu(new DOMRect(event.clientX, event.clientY, 0, 0))
                  }
                : undefined
            }
          >
            {!narrow && (
              <ResizeHandle label={t('Resize side panel')} width={sideW ?? 264} min={SIDE_MIN} max={SIDE_MAX} onResize={setSideW} />
            )}
            <header className="context-heading">
              <h2>{t(PANEL_TITLES[panel])}</h2>
              {sideOpen && sidePanelButton}
            </header>
            <div className="side-scroll" ref={setPanelHost}>
              {panel === 'vault' && sideOpen && (
                <div className="side-collections" ref={treePanel}>
                  {(favs.length > 0 || dragPage) && (
                    <div className={favs.length === 0 ? 'fav-float' : undefined}>
                      <div
                        className={'fav-zone' + (favOver ? ' over' : '')}
                        onDragOver={(e) => {
                          if (e.dataTransfer.types.includes('application/x-page')) (e.preventDefault(), setFavOver(true))
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFavOver(false)
                        }}
                        onDrop={(e) => {
                          const id = e.dataTransfer.getData('application/x-page')
                          setFavOver(false)
                          if (id && !repo.get(id)?.favorite) (e.preventDefault(), fav(id))
                        }}
                      >
                        <button className={'section' + (shut.favs ? ' shut' : '')} onClick={() => setShut((s) => ({ ...s, favs: !s.favs }))}>
                          {t('Favorites')}
                          <Icon name="chevron-right" size={13} />
                        </button>
                        {!shut.favs &&
                          favs.map((p) => (
                            <div key={p.id} dir={dirOf(p.title)} className={'row' + (p.id === current?.id ? ' cur' : '')} style={{ paddingInlineStart: 24 }} onClick={() => setCurrentId(p.id)}>
                              <span className="ic">
                                <PageIcon page={p} />
                              </span>
                              <span className="ntitle" dir="auto">
                                {p.title || t('Untitled')}
                              </span>
                            </div>
                          ))}
                        {favs.length === 0 && <div className="empty-note">{t('Drop a page here to pin it')}</div>}
                      </div>
                    </div>
                  )}

                  {saved.length > 0 && (
                    <>
                      <button className={'section' + (shut.saved ? ' shut' : '')} onClick={() => setShut((s) => ({ ...s, saved: !s.saved }))}>
                        {t('Saved searches')}
                        <Icon name="chevron-right" size={13} />
                      </button>
                      {!shut.saved &&
                        saved.map((s) => (
                          <div key={s.id} className="row saved-row" style={{ paddingInlineStart: 24 }} title={s.query} onClick={() => (setSearchInit(s.query), setSearching(true))}>
                            <span className="ic">
                              <Icon name="search" size={15} />
                            </span>
                            <span className="ntitle" dir="auto">
                              {s.name}
                            </span>
                            <span className="acts">
                              <button title={t('Delete')} onClick={(e) => (e.stopPropagation(), saveSaved(saved.filter((x) => x.id !== s.id)))}>
                                <Icon name="x" size={14} />
                              </button>
                            </span>
                          </div>
                        ))}
                    </>
                  )}

                  <div className="tree-heading">
                    <button className={'section' + (shut.pages ? ' shut' : '')} aria-expanded={!shut.pages} onClick={() => setShut((s) => ({ ...s, pages: !s.pages }))}>
                      {t('Pages')}
                      <Icon name="chevron-right" size={13} />
                    </button>
                    {settings.pagesView !== 'compact' && (
                      <>
                        <IconButton
                          label={t('Expand all folders')}
                          onClick={() => {
                            setCollapsed(new Set())
                            setShut((previous) => ({ ...previous, pages: false }))
                          }}
                        >
                          <Icon name="plus" size={15} />
                        </IconButton>
                        <IconButton
                          label={t('Collapse all folders')}
                          onClick={() => {
                            setCollapsed(new Set(pages.filter((page) => !page.database && (page.kind === 'folder' || index.kids.has(page.id))).map((page) => page.id)))
                            setShut((previous) => ({ ...previous, pages: false }))
                          }}
                        >
                          <Icon name="minus" size={15} />
                        </IconButton>
                      </>
                    )}
                    <IconButton label={t('Reveal active note')} disabled={view !== 'page' || !current || !!current.database} onClick={revealActiveNote}>
                      <Icon name="target" size={15} />
                    </IconButton>
                  </div>
                  {!shut.pages && settings.pagesView === 'compact' && (
                    <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom>
                      <div className="tree-in cmp-list">
                        <CompactList {...rowProps} roots={roots} />
                      </div>
                    </HorizontalScroll>
                  )}
                  {!shut.pages && settings.pagesView !== 'compact' && (
                    <HorizontalScroll className="tree-scroll" label={t('Pages')} followVisibleBottom>
                      <div className="tree-in">
                        {roots.map((p) => (
                          <TreeRow key={p.id} {...rowProps} page={p} depth={0} />
                        ))}
                      </div>
                    </HorizontalScroll>
                  )}
                  {!shut.pages && roots.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}

                  {tagList.length > 0 && (
                    <SidebarTags
                      tags={tagList}
                      active={tagFilter}
                      onPick={setTagFilter}
                      shut={!!shut.tags}
                      onToggle={() => setShut((x) => ({ ...x, tags: !x.tags }))}
                      pages={taggedPages}
                      currentId={current?.id}
                      onOpen={setCurrentId}
                    />
                  )}
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      <main ref={mainRef} className={'main' + (panelOpen && !reader && view === 'page' && current ? ' drawer-open' : '')}>
        <header className="topbar">
          <div className="nav-hist">
            <IconButton label={t('Back  Alt+←')} disabled={hpos.current <= 0} onClick={() => goHist(-1)}>
              <Icon name="arrow-left" size={17} className="ds-flip" />
            </IconButton>
            <IconButton label={t('Forward  Alt+→')} disabled={hpos.current >= hist.current.length - 1} onClick={() => goHist(1)}>
              <Icon name="arrow-right" size={17} className="ds-flip" />
            </IconButton>
          </div>
          <nav className="crumbs">
            <IconButton className="crumb-home" label={t('Home')} onClick={() => setView('home')}>
              <Icon name="home" size={15} />
            </IconButton>
            {graphOpen && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="graph" size={14} />
                  {t('Graph')}
                </span>
              </span>
            )}
            {tableOpen && !graphOpen && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="table" size={14} />
                  {t('All pages')}
                </span>
              </span>
            )}
            {tplOpen && !graphOpen && !tableOpen && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="templates" size={14} />
                  {t('Templates')}
                </span>
              </span>
            )}
            {cardsOpen && !tplOpen && !graphOpen && !tableOpen && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="cards" size={14} />
                  {t('Flashcards')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'home' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="panel-left" size={14} />
                  {t('Home')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'files' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="folder" size={14} />
                  {t('Files')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'trash' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="trash" size={14} />
                  {t('Trash')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'tasks' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="tasks" size={14} />
                  {t('Tasks')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'databases' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="table" size={14} />
                  {t('Databases')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'drawings' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="pencil" size={14} />
                  {t('Drawings')}
                </span>
              </span>
            )}
            {!overlayOpen && view === 'settings' && (
              <span className="crumb">
                <span className="crumb-cur">
                  <Icon name="settings" size={14} />
                  {t('Settings')}
                </span>
              </span>
            )}
            {!cardsOpen &&
              !tplOpen &&
              !graphOpen &&
              !tableOpen &&
              view === 'page' &&
              // a deep page keeps the top level and its last two ancestors in view; the ones between wait behind "…"
              (crumbs.length > 3 ? [crumbs[0], null, ...crumbs.slice(-2)] : crumbs).map((c, i, shown) =>
                c === null ? (
                  <span key="more" className="crumb crumb-more">
                    <span className="crumb-sep">
                      <Icon name="chevron-right" size={13} />
                    </span>
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-label={t('{n} more pages', { n: crumbs.length - 3 })}
                      title={t('{n} more pages', { n: crumbs.length - 3 })}
                      onClick={(e) =>
                        openCrumbs(
                          crumbs.slice(1, -2).map((p) => ({ label: p.title || t(p.kind === 'folder' ? 'Folder' : 'Untitled'), raw: !!p.title, icon: p.kind === 'folder' ? <Icon name="folder" /> : iconNode(p.icon, 16, <Icon name="file" />), onSelect: () => p.kind !== 'folder' && setCurrentId(p.id) })),
                          e.currentTarget,
                        )
                      }
                    >
                      …
                    </button>
                  </span>
                ) : (
                <span key={c.id} className={'crumb' + (i === shown.length - 1 ? ' last' : '')}>
                  <span className="crumb-sep">
                    <Icon name="chevron-right" size={13} />
                  </span>
                  {c.kind === 'folder' ? (
                    <span className="crumb-folder" dir="auto" title={c.title || t('Folder')}>
                      <Icon name="folder" size={14} />
                      <span>{c.title || t('Folder')}</span>
                    </span>
                  ) : (
                    <button onClick={() => setCurrentId(c.id)} dir="auto" title={c.title || t('Untitled')}>
                      <span className="ic">{iconNode(c.icon, 14)}</span>
                      <span className="crumb-t">{c.title || t('Untitled')}</span>
                    </button>
                  )}
                </span>
                ),
              )}
          </nav>
          {crumbsMenu}
          <span className="spacer" />
          {current && view === 'page' && <SaveStatus state={save} label={save === 'saving' ? t('Saving…') : t('All changes saved')} />}
          <div className="tb-group">
            {current && view === 'page' && (
              <>
                <IconButton label={t('Reader mode') + '  ' + bindingHint('reader')} onClick={() => setReader(true)}>
                  <Icon name="book" size={17} />
                </IconButton>
                <IconButton label={t('Page side panel (quick actions & navigation)')} pressed={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
                  <Icon name="panel-right" size={17} />
                </IconButton>
              </>
            )}
            <IconButton label={(fullScreen ? t('Exit full screen') : t('Full screen')) + '  ' + commandHint('Full screen')} pressed={fullScreen} className="ds-icon-btn--toggle topbar-fullscreen" onClick={() => void toggleFullScreen()}>
              <Icon name={fullScreen ? 'minimize' : 'maximize'} size={17} />
            </IconButton>
            <IconButton label={dark ? t('Light mode') : t('Dark mode')} onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}>
              <Icon name={dark ? 'sun' : 'moon'} size={17} />
            </IconButton>
          </div>
          {current && view === 'page' && (
            <IconButton className="ds-icon-btn--toggle" pressed={!!current.favorite} label={current.favorite ? t('Remove from favorites') : t('Add to favorites')} onClick={() => fav(current.id)}>
              <Icon name="star" size={18} />
            </IconButton>
          )}
          {current && view === 'page' && (
            <Button variant="primary" size="sm" className="share-btn" title={t('Share & export')} icon={<Icon name="share" size={16} />} aria-haspopup="menu" onClick={(e) => openShare(shareItems(current), e.currentTarget)}>
              <span className="share-btn-label">{t('Share')}</span>
            </Button>
          )}
        </header>

        {reader && view === 'page' && current && <ReaderBar cfg={readerCfg} onCfg={(c) => (setReaderCfg(c), setPreference('not.reader.cfg', JSON.stringify(c)))} onExit={() => setReader(false)} />}
        <div className="scroller">
          {graphOpen ? (
            <GraphView currentId={current?.id} onOpen={setCurrentId} onClose={() => setGraphOpen(false)} />
          ) : tableOpen ? (
            <PagesTable pages={pages} onOpen={setCurrentId} onStatus={setStatus} onClose={() => setTableOpen(false)} />
          ) : tplOpen ? (
            <Templates onPick={addFromTemplate} onClose={() => setTplOpen(false)} />
          ) : cardsOpen ? (
            <Flashcards
              pageId={view === 'page' ? current?.id : undefined}
              onOpenPage={(id) => (setCardsOpen(false), setCurrentId(id))}
              onClose={() => (setCardsOpen(false), window.dispatchEvent(new Event('cards-reviewed')))}
            />
          ) : view === 'home' ? (
            <Home
              pages={pages}
              onPagesChange={refresh}
              onOpen={setCurrentId}
              onNew={() => add(null)}
              onTable={() => setTableOpen(true)}
              onCards={() => setCardsOpen(true)}
              onTemplates={() => setTplOpen(true)}
              onTemplate={addFromTemplate}
              onImport={openData}
              onFiles={() => setView('files')}
              onTasks={() => setView('tasks')}
            />
          ) : view === 'files' ? (
            <Explorer pages={pages} onOpen={setCurrentId} onChange={refresh} onToast={(msg, undo) => setToast({ msg, undo })} />
          ) : view === 'trash' ? (
            <Trash items={trashed} days={TRASH_DAYS} onRestore={restore} onPurge={purge} onEmpty={emptyTrash} />
          ) : view === 'tasks' ? (
            <Tasks panelHost={panelHost} index={index} onOpen={setCurrentId} onNewList={() => add(null, 'todo')} />
          ) : view === 'databases' ? (
            <Databases onOpen={setCurrentId} onNew={() => addDatabase(null)} onDelete={del} />
          ) : view === 'drawings' ? (
            <Drawings onOpen={setCurrentId} onNew={() => add(null, 'board')} onDelete={delDrawing} />
          ) : view === 'settings' ? (
            <SettingsView
              key={settingsTab ?? 'settings'}
              panelHost={panelHost}
              initialTab={settingsTab}
              onLeave={() => setView('home')}
              data={{ repo, refresh, toast: (msg) => setToast({ msg }), open: setCurrentId, exportAll: doExportAll, backup: doBackup, workspaces: () => setFolderOpen(true) }}
            />
          ) : current?.dbHost ? (
            <Suspense fallback={<div className="page-skeleton" aria-busy="true" />}>
              <DatabasePage key={current.id} page={current} onOpenPage={setCurrentId} onMeta={refresh} readOnly={reader} />
            </Suspense>
          ) : current?.kind === 'board' ? (
            <BoardView key={current.id} page={current} onSave={setSave} onMeta={refresh} onBack={() => (closeOverlays(), setView('drawings'))} readOnly={reader} />
          ) : current ? (
            <>
              <div className={'page-cols' + (current.cover ? ' has-cover' : '')}>
                <PageView
                  key={current.id}
                  page={current}
                  onSave={setSave}
                  onMeta={refresh}
                  onCover={setCoverMenu}
                  cover={current.cover && <CoverBanner cover={current.cover} onChange={setCoverMenu} onRemove={() => setCover(undefined)} />}
                  readOnly={reader}
                />
              </div>
            </>
          ) : (
            <div className="blank">
              <div className="blank-ic">
                <Icon name="file" size={40} />
              </div>
              <h2>{t('No page open')}</h2>
              <p>{t('Create a page or search with {keys}.', { keys: bindingHint('search').replace(/ /g, '+') })}</p>
              <Button variant="primary" onClick={() => add(null)}>
                {t('New page')}
              </Button>
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
            onCover={setCoverMenu}
            onExport={() => exportMd(current.id)}
          />
        )}
      </main>

      {menu && menuPage && (
        <Menu
          anchor={menu.rect}
          align="end"
          onClose={() => setMenu(null)}
          items={[
            ...(menuPage.kind !== 'folder'
              ? [
                  { label: t('Open'), icon: <Icon name="external-link" size={16} />, onSelect: () => (setCurrentId(menu.id), setView('page')) },
                  { label: menuPage.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: <Icon name="star" size={16} />, onSelect: () => fav(menu.id) },
                ]
              : []),
            { kind: 'sep' as const },
            { kind: 'head' as const, label: t('Create') },
            { label: menuPage.kind === 'folder' ? t('Add page in this folder') : t('Add subpage'), icon: <Icon name="plus" size={16} />, onSelect: () => add(menu.id) },
            { label: t('Add folder'), icon: <Icon name="folder-plus" size={16} />, onSelect: () => addFolder(menu.id) },
            { label: t('Add board'), icon: <Icon name="pencil" size={16} />, onSelect: () => add(menu.id, 'board') },
            { kind: 'sep' as const },
            { kind: 'head' as const, label: t('Organize') },
            { label: t('Rename'), icon: <Icon name="pencil" size={16} />, onSelect: () => rename(menu.id) },
            ...(menuPage.kind !== 'folder' ? [{ label: t('Duplicate'), icon: <Icon name="copy" size={16} />, onSelect: () => duplicate(menu.id) }] : []),
            { label: t('Move to folder'), icon: <Icon name="folder" size={16} />, onSelect: () => setMovingId(menu.id) },
            ...(menuPage.parentId ? [{ label: t('Move to top level'), icon: <Icon name="arrow-up" size={16} />, onSelect: () => move(menu.id, null, null) }] : []),
            { label: t('Copy title'), icon: <Icon name="clipboard" size={16} />, onSelect: () => void navigator.clipboard?.writeText(menuPage.title || '') },
            ...(isTauri
              ? [
                  { label: t('Copy path'), icon: <Icon name="clipboard" size={16} />, onSelect: () => copyPath(menu.id) },
                  { label: t(revealKey), icon: <Icon name="folder" size={16} />, onSelect: () => revealFile(menu.id) },
                ]
              : []),
            ...(menuPage.kind !== 'folder' ? [{ label: t('Export Markdown'), icon: <Icon name="markdown" size={16} />, onSelect: () => exportMd(menu.id) }] : []),
            { kind: 'sep' as const },
            { label: t('Delete'), icon: <Icon name="trash" size={16} />, danger: true, hint: shortcutHint('Delete'), onSelect: () => del(menu.id) },
          ]}
        />
      )}

      {blankMenu && (
        <Menu
          anchor={blankMenu}
          onClose={() => setBlankMenu(null)}
          items={[
            { label: t('New page'), icon: <Icon name="plus" size={16} />, onSelect: () => add(null) },
            { label: t('New folder'), icon: <Icon name="folder-plus" size={16} />, onSelect: () => addFolder(null) },
            { label: t('New board'), icon: <Icon name="pencil" size={16} />, onSelect: () => add(null, 'board') },
            { label: t('New database'), icon: <Icon name="table" size={16} />, onSelect: () => addDatabase(null) },
            { label: t('New to-do list'), icon: <Icon name="checklist" size={16} />, onSelect: () => add(null, 'todo') },
            { label: t('New from template…'), icon: <Icon name="blocks" size={16} />, onSelect: () => setTplOpen(true) },
            { kind: 'sep' as const },
            { kind: 'head' as const, label: t('Go to') },
            { label: t('Home'), icon: <Icon name="home" size={16} />, onSelect: () => setView('home') },
            { label: t('Files'), icon: <Icon name="folder-plus" size={16} />, onSelect: () => setView('files') },
            { label: t('Databases'), icon: <Icon name="table" size={16} />, onSelect: () => setView('databases') },
            { label: t('All pages'), icon: <Icon name="table" size={16} />, onSelect: () => setTableOpen(true) },
            { label: t('Flashcards'), icon: <Icon name="cards" size={16} />, onSelect: () => setCardsOpen(true) },
            { label: t('Graph'), icon: <Icon name="link" size={16} />, onSelect: () => setGraphOpen(true) },
            { kind: 'sep' as const },
            { label: t('Import or restore…'), icon: <Icon name="upload" size={16} />, onSelect: () => openData() },
            { label: t('Trash'), icon: <Icon name="trash" size={16} />, onSelect: () => setView('trash') },
            { label: t('Settings'), icon: <Icon name="settings" size={16} />, onSelect: () => setView('settings') },
          ]}
        />
      )}

      {coverMenu && current && (
        <Popover anchor={coverMenu} onClose={() => setCoverMenu(null)}>
          <CoverPicker page={current} onPick={setCover} onClose={() => setCoverMenu(null)} />
        </Popover>
      )}

      {shareMenu}

      {folderOpen && (
        <Vaults
          onClose={() => setFolderOpen(false)}
          onNew={(create) => setNaming({ title: t('New workspace'), label: t('Workspace name:'), initial: t('My notes'), action: t('Next'), onSubmit: (n) => void create(n.trim() || t('My notes')) })}
        />
      )}
      {movingId && (
        <Dialog open title={t('Move to folder')} onClose={() => setMovingId(null)}>
          <div className="ds-modal-body">
            <div className="ds-list ds-list--framed">
              <Row
                as="button"
                className="ds-list-row"
                icon={<Icon name="book" size={16} />}
                text={t('Move to top level')}
                onClick={() => {
                  move(movingId, null, null)
                  setMovingId(null)
                }}
              />
              {pages
                .filter((p) => {
                  if (p.kind !== 'folder' || p.id === movingId) return false
                  let parent: Page | undefined = p
                  const seen = new Set<string>()
                  while (parent) {
                    if (parent.id === movingId || seen.has(parent.id)) return false
                    seen.add(parent.id)
                    parent = pages.find((x) => x.id === parent!.parentId)
                  }
                  return true
                })
                .map((p) => (
                  <Row
                    as="button"
                    className="ds-list-row"
                    key={p.id}
                    icon={<Icon name="folder" size={16} />}
                    text={p.title || t('Untitled folder')}
                    onClick={() => {
                      move(movingId, p.id, null)
                      setMovingId(null)
                    }}
                  />
                ))}
            </div>
          </div>
        </Dialog>
      )}

      {naming && <NameDialog {...naming} onClose={() => setNaming(null)} />}
      <UpdateCenter />
      {toast && <Toast msg={toast.msg} action={toast.undo ? t('Undo') : toast.action?.label} onAction={toast.undo ?? toast.action?.run} actionHint={toast.undo ? shortcutLabel(['Mod', 'Z']) : undefined} onClose={() => setToast(null)} />}

      {searching && (
        <SearchModal
          pages={pages.filter((p) => p.kind !== 'folder')}
          search={searchPages}
          commands={commands}
          onOpen={setCurrentId}
          initialQuery={searchInit}
          onClose={() => (setSearching(false), setSearchInit(''))}
          onSaveSearch={(query) =>
            setNaming({
              title: t('Save this search'),
              label: t('Name:'),
              initial: query,
              action: t('Save'),
              onSubmit: (name) => saveSaved([...saved, { id: crypto.randomUUID(), name: name.trim() || query, query }]),
            })
          }
        />
      )}
    </div>
  )
}
