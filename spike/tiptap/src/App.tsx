import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { repo, gcFiles, TRASH_DAYS } from './store'
import type { Cover, Page, PageStatus } from './repo'
import { SettingsView } from './SettingsPage'
import { CoverBanner, CoverPicker } from './Cover'
import { PagePanel } from './PagePanel'
import { PageIcon } from './PageIcon'
import { isDark, updateSettings, useSettings } from './settings'
import { BackupError, buildBackup, download, pageToMarkdown, restoreBackup } from './backup'
import { exportAllZip, importMarkdown, importVault, pickDirectory, pickFiles } from './io'
import { PagesTable } from './PagesTable'
import { Flashcards } from './Flashcards'
import { PageView, type SaveState } from './PageView'
import { ReaderBar, loadReaderCfg, type ReaderCfg } from './ReaderBar'
import { BackupSettings } from './BackupSettings'
import { MenuItem, NameDialog, Popover, SearchModal, Toast, TrashModal, type PaletteCommand } from './ui'
import { Home } from './Home'
import { iconNode } from './iconSet'
import * as Ic from './icons'
import { OPEN_PAGE, PAGES_CHANGED } from './editor/pageLink'
import './App.css'
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
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* private mode etc. — preferences are optional */
  }
}

interface RowProps {
  page: Page
  depth: number
  pages: Page[]
  currentId: string
  collapsed: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  onAdd: (parentId: string) => void
  onMenu: (id: string, rect: DOMRect) => void
  onMove: (id: string, parentId: string | null, beforeId: string | null) => void
}

function TreeRow(props: RowProps) {
  const { page, depth, pages, currentId, collapsed } = props
  const [zone, setZone] = useState<'before' | 'inside' | 'after' | null>(null)
  const kids = pages.filter((p) => p.parentId === page.id).sort((a, b) => a.sort - b.sort)
  const open = !collapsed.has(page.id)
  const folder = page.kind === 'folder'
  return (
    <>
      <div
        className={'row' + (page.id === currentId ? ' cur' : '') + (zone ? ' drop-' + zone : '')}
        style={{ paddingInlineStart: 6 + depth * 14 }}
        draggable
        onClick={() => (folder ? props.onToggle(page.id) : props.onOpen(page.id))}
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
          const sibs = pages.filter((p) => p.parentId === page.parentId && p.id !== dragged).sort((a, b) => a.sort - b.sort)
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
        <span className="acts">
          <button title={t('Options')} onClick={(e) => (e.stopPropagation(), props.onMenu(page.id, e.currentTarget.getBoundingClientRect()))}><Ic.Dots size={16} /></button>
          <button title={folder ? t('New page in folder') : t('New subpage')} onClick={(e) => (e.stopPropagation(), props.onAdd(page.id))}><Ic.Plus size={16} /></button>
        </span>
      </div>
      {open && kids.map((k) => <TreeRow key={k.id} {...props} page={k} depth={depth + 1} />)}
    </>
  )
}

export default function App() {
  const [pages, setPages] = useState<Page[]>(() => repo.list())
  const [currentId, setCurrentIdRaw] = useState<string>(() => localStorage.getItem('not.current') || repo.pagesOnly()[0]?.id || '')
  const [view, setView] = useState<'home' | 'page' | 'settings'>('home')
  const [panelOpen, setPanelOpen] = useState<boolean>(() => store('not.panel.v2', false))
  const [coverMenu, setCoverMenu] = useState<DOMRect | null>(null)
  // opening any page (sidebar, search, link, breadcrumb…) also leaves the settings view
  const setCurrentId = useCallback((id: string) => (setView('page'), setCurrentIdRaw(id)), [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [shut, setShut] = useState<{ favs: boolean; pages: boolean }>({ favs: false, pages: false })
  const [save, setSave] = useState<SaveState>('saved')
  const [sideOpen, setSideOpen] = useState<boolean>(() => store('not.side', true))
  const [searching, setSearching] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [naming, setNaming] = useState<{ title: string; label: string; initial: string; action: string; onSubmit: (name: string) => void } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const [cardsOpen, setCardsOpen] = useState(false)
  const [dataMenu, setDataMenu] = useState<DOMRect | null>(null)
  const [shareMenu, setShareMenu] = useState<DOMRect | null>(null)
  const [trashTick, setTrashTick] = useState(0)
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null)
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null)
  const [reader, setReader] = useState(false)
  const [readerCfg, setReaderCfg] = useState<ReaderCfg>(loadReaderCfg)
  const [pageW, setPageW] = useState<number>(() => Number(localStorage.getItem('not.page.width')) || PAGE_W.def)
  const readerRef = useRef(reader)
  readerRef.current = reader
  const settings = useSettings()

  const refresh = useCallback(() => setPages(repo.list()), [])
  const current = pages.find((p) => p.id === currentId && p.kind !== 'folder') ?? pages.find((p) => p.kind !== 'folder')

  useEffect(() => {
    if (current) localStorage.setItem('not.current', current.id)
  }, [current])
  useEffect(() => put('not.side', sideOpen), [sideOpen])
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
    return () => {
      window.removeEventListener(OPEN_PAGE, open)
      window.removeEventListener(PAGES_CHANGED, changed)
    }
  }, [refresh])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') (e.preventDefault(), setSearching(true))
      if (mod && e.key === '\\') (e.preventDefault(), setSideOpen((s) => !s))
      // Alt + = / Alt + -: wider / narrower text column (in reader mode: the reader page)
      if (e.altKey && !mod && !e.shiftKey && (e.code === 'Equal' || e.code === 'Minus')) {
        e.preventDefault()
        const d = e.code === 'Equal' ? PAGE_W.step : -PAGE_W.step
        if (readerRef.current) setReaderCfg((c) => { const n = { ...c, width: Math.min(1400, Math.max(480, c.width + d)) }; localStorage.setItem('not.reader.cfg', JSON.stringify(n)); return n })
        else setPageW((w) => { const n = Math.min(PAGE_W.max, Math.max(PAGE_W.min, w + d)); localStorage.setItem('not.page.width', String(n)); return n })
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'Period') (e.preventDefault(), setReader((r) => !r)) // physical key: works with the Persian layout
      if (e.key === 'Escape' && !document.querySelector('.lightbox')) setReader(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const add = (parentId: string | null) => {
    const p = repo.create(parentId)
    if (parentId) expand(parentId)
    refresh()
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
  const purge = async (p: Page) => {
    if (!confirm(t('“{title}” will be deleted permanently. This cannot be undone.', { title: p.title || t('Untitled') }))) return
    repo.purge(p.id)
    await gcFiles()
    refresh()
    setTrashTick((t) => t + 1)
  }
  const emptyTrash = async () => {
    if (!confirm(t('Permanently delete everything in the trash? This cannot be undone.'))) return
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
  const doBackup = async () => download(`notes-backup-${stamp()}.json`, await buildBackup(repo))
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
    if (!f || !confirm(t('All current pages will be replaced by the backup. Continue?'))) return
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

  const roots = useMemo(() => pages.filter((p) => !p.parentId).sort((a, b) => a.sort - b.sort), [pages])
  const favs = pages.filter((p) => p.favorite)
  const crumbs = useMemo(() => {
    const out: Page[] = []
    for (let p: Page | undefined = current; p; p = p.parentId ? pages.find((x) => x.id === p!.parentId) : undefined) out.unshift(p)
    return out
  }, [current, pages])
  const commands: PaletteCommand[] = [
    { id: 'new-page', label: t('New page'), icon: <Ic.Page />, keywords: 'create add صفحه جدید', run: () => add(null) },
    { id: 'new-folder', label: t('New folder'), icon: <Ic.Folder />, keywords: 'create add پوشه', run: () => addFolder(null) },
    ...(current && view === 'page' ? [
      { id: 'subpage', label: t('Add subpage'), icon: <Ic.Plus />, keywords: 'زیرصفحه', run: () => add(current.id) },
      { id: 'fav', label: current.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: <Ic.Star filled={current.favorite} />, keywords: 'star pin علاقه‌مندی', run: () => fav(current.id) },
      { id: 'reader', label: t('Reader mode'), icon: <Ic.Book />, keywords: 'read مطالعه', hint: 'Ctrl .', run: () => setReader(true) },
      { id: 'export-md', label: t('Export Markdown'), icon: <Ic.Markdown />, keywords: 'download خروجی', run: () => exportMd(current.id) },
    ] : []),
    { id: 'home', label: t('Home'), icon: <Ic.Home />, keywords: 'dashboard خانه', run: () => setView('home') },
    { id: 'table', label: t('Pages table'), icon: <Ic.Table />, keywords: 'database جدول', run: () => setTableOpen(true) },
    { id: 'cards', label: t('Flashcards'), icon: <Ic.Cards />, keywords: 'review srs فلش‌کارت', run: () => setCardsOpen(true) },
    { id: 'trash', label: t('Trash'), icon: <Ic.Trash />, keywords: 'deleted سطل', run: () => setTrashOpen(true) },
    { id: 'theme', label: dark ? t('Light mode') : t('Dark mode'), icon: dark ? <Ic.Sun /> : <Ic.Moon />, keywords: 'theme dark light تم', run: () => updateSettings({ theme: dark ? 'light' : 'dark' }) },
    { id: 'sidebar', label: sideOpen ? t('Close sidebar') : t('Open sidebar'), icon: <Ic.Sidebar />, keywords: 'side panel نوار کناری', hint: 'Ctrl \\', run: () => setSideOpen((o) => !o) },
    { id: 'import', label: t('Import Markdown files…'), icon: <Ic.Upload />, keywords: 'وارد کردن', run: doImport },
    { id: 'vault', label: t('Import Obsidian vault (folder)…'), icon: <Ic.Folder />, keywords: 'obsidian', run: doVault },
    { id: 'export-all', label: t('Export all pages (zip with Markdown & images)'), icon: <Ic.Download />, keywords: 'zip', run: doExportAll },
    { id: 'backup', label: t('Full backup (JSON)'), icon: <Ic.Save />, keywords: 'پشتیبان', run: doBackup },
    { id: 'auto-backup', label: t('Automatic backup to folder…'), icon: <Ic.Save />, keywords: 'پشتیبان خودکار', run: () => setBackupOpen(true) },
    { id: 'settings', label: t('Settings'), icon: <Ic.Settings />, keywords: 'preferences تنظیمات', run: () => setView('settings') },
  ]
  const menuPage = menu ? pages.find((p) => p.id === menu.id) : undefined

  const rowProps = { pages, currentId: current?.id ?? '', collapsed, onToggle: toggle, onOpen: setCurrentId, onAdd: add, onMenu: (id: string, rect: DOMRect) => setMenu({ id, rect }), onMove: move }

  return (
    <div className={'app' + (reader && view === 'page' && current ? ' reading' : '')} style={{ ['--page-w' as any]: pageW + 'px', ['--r-scale' as any]: readerCfg.scale, ['--r-width' as any]: readerCfg.width + 'px' }}>
      <aside className={'side' + (sideOpen ? '' : ' closed')}>
        <div className="ws">
          <span className="ws-logo"><Ic.Logo size={24} /></span>
          <span className="ws-name">Noviq</span>
          <button className="icon-btn" title={t('Close sidebar  Ctrl+\\')} onClick={() => setSideOpen(false)}><Ic.Sidebar /></button>
        </div>

        <div className="side-scroll">
          <button className="row plain search-row" onClick={() => setSearching(true)}>
            <span className="ic"><Ic.Search /></span><span className="ntitle">{t('Search')}...</span><kbd>Ctrl K</kbd>
          </button>

          <button className={'row plain' + (view === 'home' ? ' cur' : '')} onClick={() => setView('home')}>
            <span className="ic"><Ic.Home /></span><span className="ntitle">{t('Home')}</span>
          </button>

          <button className={'row plain' + (view === 'settings' ? ' cur' : '')} onClick={() => setView('settings')}>
            <span className="ic"><Ic.Settings /></span><span className="ntitle">{t('Settings')}</span>
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

          <button className={"section" + (shut.pages ? " shut" : "")} onClick={() => setShut((s) => ({ ...s, pages: !s.pages }))}>{t('Pages')}<Ic.Chevron size={13} /></button>
          {!shut.pages && roots.map((p) => <TreeRow key={p.id} {...rowProps} page={p} depth={0} />)}
          {!shut.pages && roots.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}

          <div className="side-utils">
          <button className="row plain" onClick={() => addFolder(null)}>
            <span className="ic"><Ic.Folder /></span><span className="ntitle">{t('New folder')}</span>
          </button>
          <button className="row plain" onClick={() => setTrashOpen(true)}>
            <span className="ic"><Ic.Trash /></span><span className="ntitle">{t('Trash')}</span>
            {repo.trash().length > 0 && <span className="badge">{repo.trash().length}</span>}
          </button>
          <button className="row plain" onClick={(e) => setDataMenu(e.currentTarget.getBoundingClientRect())}>
            <span className="ic"><Ic.Download /></span><span className="ntitle">{t('Data & backup')}</span>
          </button>
          </div>
        </div>

        <div className="side-foot">
          <button className="new-page" onClick={() => add(null)}>
            <Ic.Plus size={16} /><span>{t('New page')}</span>
          </button>
          <div className="side-credit">{t('Created by')} Vexor</div>
        </div>
      </aside>

      <main className={'main' + (panelOpen && !reader && view === 'page' && current ? ' drawer-open' : '')}>
        <header className="topbar">
          {!sideOpen && <button className="icon-btn" title={t('Open sidebar  Ctrl+\\')} onClick={() => setSideOpen(true)}><Ic.Sidebar /></button>}
          <nav className="crumbs">
            <span className="crumb-home"><Ic.Home size={15} /></span>
            {view === 'home' && <span className="crumb"><span className="crumb-folder">{t('Home')}</span></span>}
            {view === 'settings' && <span className="crumb"><span className="crumb-folder"><span className="ic"><Ic.Settings size={15} /></span>{t('Settings')}</span></span>}
            {view === 'page' && crumbs.map((c, i) => (
              <span key={c.id} className="crumb">
                {i > 0 && <span className="crumb-sep">/</span>}
                {c.kind === 'folder' ? (
                  <span className="crumb-folder" dir="auto"><span className="ic">📁</span>{c.title || t('Folder')}</span>
                ) : (
                  <button onClick={() => setCurrentId(c.id)} dir="auto">
                    <span className="ic">{iconNode(c.icon, 15)}</span>{c.title || t('Untitled')}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <span className={'status' + (save === 'saving' ? ' busy' : '')}><i className="dot" />{save === 'saving' ? t('Saving…') : t('Saved')}</span>
          {current && view === 'page' && (
            <>
              <button className="icon-btn" title={t('Reader mode  Ctrl+.')} onClick={() => setReader(true)}><Ic.Book /></button>
              <button className={'icon-btn' + (current.favorite ? ' fav-on' : '')} title={t('Favorite')} onClick={() => fav(current.id)}><Ic.Star filled={current.favorite} /></button>
              <button className="share-btn" title={t('Import & export')} onClick={(e) => setShareMenu(e.currentTarget.getBoundingClientRect())}><Ic.Share size={15} />{t('Share')}</button>
              <button className={'icon-btn panel-toggle' + (panelOpen ? ' active' : '')} title={t('Page side panel (quick actions & navigation)')} onClick={() => setPanelOpen((o) => !o)}><Ic.Panel /></button>
            </>
          )}
          <button className="icon-btn" title={dark ? t('Light mode') : t('Dark mode')} onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}>
            {dark ? <Ic.Sun /> : <Ic.Moon />}
          </button>
        </header>

        {reader && view === 'page' && current && <ReaderBar cfg={readerCfg} onCfg={(c) => (setReaderCfg(c), localStorage.setItem('not.reader.cfg', JSON.stringify(c)))} onExit={() => setReader(false)} />}
        <div className="scroller">
          {view === 'home' ? (
            <Home pages={pages} onOpen={setCurrentId} onNew={() => add(null)} onFolder={() => addFolder(null)} onTable={() => setTableOpen(true)} onCards={() => setCardsOpen(true)} onSearch={() => setSearching(true)} />
          ) : view === 'settings' ? (
            <SettingsView />
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
          <div className="menu">
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Star filled={menuPage.favorite} />} label={menuPage.favorite ? t('Remove from favorites') : t('Add to favorites')} onClick={() => (fav(menu.id), setMenu(null))} />}
            <MenuItem icon={<Ic.Plus />} label={menuPage.kind === 'folder' ? t('Add page in this folder') : t('Add subpage')} onClick={() => (add(menu.id), setMenu(null))} />
            <MenuItem icon={<Ic.Folder />} label={t('Add folder')} onClick={() => (addFolder(menu.id), setMenu(null))} />
            <MenuItem icon={<Ic.Page />} label={t('Rename')} onClick={() => (rename(menu.id), setMenu(null))} />
            {menuPage.kind !== 'folder' && <MenuItem icon={<Ic.Markdown />} label={t('Export Markdown')} onClick={() => (exportMd(menu.id), setMenu(null))} />}
            <div className="menu-sep" />
            <MenuItem danger icon={<Ic.Trash />} label={t('Delete')} hint="Delete" onClick={() => (del(menu.id), setMenu(null))} />
          </div>
        </Popover>
      )}

      {coverMenu && current && (
        <Popover anchor={coverMenu} onClose={() => setCoverMenu(null)}>
          <CoverPicker page={current} onPick={setCover} onClose={() => setCoverMenu(null)} />
        </Popover>
      )}

      {shareMenu && current && (
        <Popover anchor={shareMenu} onClose={() => setShareMenu(null)} align="end">
          <div className="menu">
            <MenuItem icon={<Ic.Markdown />} label={t('Export Markdown')} onClick={() => (setShareMenu(null), exportMd(current.id))} />
            <MenuItem icon={<Ic.Markdown />} label={t('Export all pages (zip with Markdown & images)')} onClick={() => (setShareMenu(null), doExportAll())} />
            <div className="menu-sep" />
            <MenuItem icon={<Ic.Upload />} label={t('Import Markdown files…')} onClick={() => (setShareMenu(null), doImport())} />
            <MenuItem icon={<Ic.Folder />} label={t('Import Obsidian vault (folder)…')} onClick={() => (setShareMenu(null), doVault())} />
            <div className="menu-sep" />
            <MenuItem icon={<Ic.Download />} label={t('Full backup (JSON)')} onClick={() => (setShareMenu(null), doBackup())} />
            <MenuItem icon={<Ic.Upload />} label={t('Restore from backup…')} onClick={() => (setShareMenu(null), doRestore())} />
          </div>
        </Popover>
      )}

      {dataMenu && (
        <Popover anchor={dataMenu} onClose={() => setDataMenu(null)}>
          <div className="menu">
            <MenuItem icon={<Ic.Upload />} label={t('Import Markdown files…')} onClick={() => (setDataMenu(null), doImport())} />
            <MenuItem icon={<Ic.Folder />} label={t('Import Obsidian vault (folder)…')} onClick={() => (setDataMenu(null), doVault())} />
            <MenuItem icon={<Ic.Table />} label={t('Pages table')} onClick={() => (setDataMenu(null), setTableOpen(true))} />
            <MenuItem icon={<Ic.Cards />} label={t('Flashcards')} onClick={() => (setDataMenu(null), setCardsOpen(true))} />
            <MenuItem icon={<Ic.Markdown />} label={t('Export all pages (zip with Markdown & images)')} onClick={() => (setDataMenu(null), doExportAll())} />
            <div className="menu-sep" />
            <MenuItem icon={<Ic.Save />} label={t('Automatic backup to folder…')} onClick={() => (setDataMenu(null), setBackupOpen(true))} />
            <MenuItem icon={<Ic.Download />} label={t('Full backup (JSON)')} onClick={() => (setDataMenu(null), doBackup())} />
            <MenuItem icon={<Ic.Upload />} label={t('Restore from backup…')} onClick={() => (setDataMenu(null), doRestore())} />
          </div>
        </Popover>
      )}

      {backupOpen && <BackupSettings onClose={() => setBackupOpen(false)} />}
      {tableOpen && <PagesTable pages={pages} onOpen={setCurrentId} onStatus={setStatus} onClose={() => setTableOpen(false)} />}
      {cardsOpen && <Flashcards pageId={view === 'page' ? current?.id : undefined} onOpenPage={(id) => (setCardsOpen(false), setCurrentId(id))} onClose={() => setCardsOpen(false)} />}

      {naming && <NameDialog {...naming} onClose={() => setNaming(null)} />}
      {trashOpen && (
        <TrashModal key={trashTick} items={repo.trash()} days={TRASH_DAYS} onRestore={restore} onPurge={purge} onEmpty={emptyTrash} onClose={() => setTrashOpen(false)} />
      )}
      {toast && <Toast msg={toast.msg} action={toast.undo ? t('Undo') : undefined} onAction={toast.undo} onClose={() => setToast(null)} />}

      {searching &&<SearchModal pages={pages.filter((p) => p.kind !== 'folder')} search={(q) => repo.search(q)} commands={commands} onOpen={setCurrentId} onClose={() => setSearching(false)} />}
    </div>
  )
}
