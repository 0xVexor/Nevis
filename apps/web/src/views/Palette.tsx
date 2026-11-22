import { useEffect, useMemo, useState } from 'react'
import { Icon, SearchPalette, type PaletteSection } from '../ds'
import { setDeviceSettings, useDeviceSettings } from '../deviceSettings'
import { go } from '../router'
import { t } from '../i18n'
import type { Workspace } from '../workspace'

/** Ctrl/⌘ K: pages by title and text (the index of M10; titles only while it is first built) and the app's commands. */
export function Palette({ ws, onClose, onNewPage, onNewDatabase }: { ws: Workspace; onClose: () => void; onNewPage: () => void; onNewDatabase: () => void }) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const device = useDeviceSettings()
  const [hitIds, setHitIds] = useState<string[] | null>(null)
  useEffect(() => {
    // the index answers when it is ready; until then (the first build) titles are matched directly
    if (!query.trim() || !ws.search.ready) { setHitIds(null); return }
    let dead = false
    const t = setTimeout(() => void ws.search.search(query, 20).then(h => { if (!dead) setHitIds(h.map(x => x.id)) }), 60)
    return () => { dead = true; clearTimeout(t) }
  }, [query, ws.search.ready])
  const sections = useMemo<PaletteSection[]>(() => {
    const out: PaletteSection[] = []
    const q = query.trim().toLowerCase()
    const cmds = [
      { id: 'new-page', icon: 'plus', title: t('New page'), run: onNewPage },
      { id: 'new-db', icon: 'table', title: t('New database'), run: onNewDatabase },
      { id: 'home', icon: 'home', title: t('Home'), run: () => go({ name: 'home' }) },
      { id: 'all', icon: 'folder', title: t('All pages'), run: () => go({ name: 'all' }) },
      { id: 'templates', icon: 'templates', title: t('Templates'), run: () => go({ name: 'templates' }) },
      { id: 'settings', icon: 'settings', title: t('Settings'), run: () => go({ name: 'settings' }) },
      { id: 'theme', icon: 'eye', title: `${t('Theme')}: ${device.theme === 'dark' ? t('Light') : t('Dark')}`, run: () => setDeviceSettings({ theme: device.theme === 'dark' ? 'light' : 'dark' }) },
    ].filter(c => !q || c.title.toLowerCase().includes(q))
    if (scope !== 'pages' && cmds.length) out.push({ label: t('Commands'), items: cmds.map(c => ({ id: `cmd-${c.id}`, icon: <Icon name={c.icon} />, title: c.title, onChoose: c.run })) })
    if (scope !== 'commands') {
      const byId = new Map(ws.data.pages.map(p => [p.id, p]))
      const pages = hitIds ? hitIds.map(id => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p) : ws.searchTitles(query, 20)
      if (pages.length) out.push({ label: t('Pages'), items: pages.map(p => ({ id: `page-${p.id}`, icon: <Icon name={p.type === 'database' ? 'table' : 'file-text'} />, title: p.title || t('Untitled'), onChoose: () => go({ name: 'page', id: p.id }) })) })
    }
    return out
  }, [query, scope, ws.data, device.theme, hitIds])
  return (
    <SearchPalette
      label={t('Search or run a command')} query={query} onQuery={setQuery} placeholder={t('Search or run a command')}
      scopes={[{ id: 'all', label: t('Show all') }, { id: 'pages', label: t('Pages') }, { id: 'commands', label: t('Commands') }]} scope={scope} onScope={setScope}
      countLabel={t('Pages')} sections={sections} emptyHint={t('No results')} onClose={onClose}
    />
  )
}
