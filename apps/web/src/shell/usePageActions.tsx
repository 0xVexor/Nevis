import { useState } from 'react'
import { isInside } from '@nevis/core'
import { uuidv7 } from '@nevis/schema'
import { Dialog, Icon, NameDialog, Row, type MenuItem } from '../ds'
import { download } from '../download'
import { t } from '../i18n'
import { href } from '../router'
import type { Workspace } from '../workspace'
import type { Page } from './model'

/** Shared page actions for the tree and the header; all writes stay in Workspace. */
export function usePageActions(ws: Workspace, pages: Page[], open: (id: string) => void, reveal: (id: string) => void) {
  const [renaming, setRenaming] = useState<Page | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [folderParent, setFolderParent] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const databases = new Set(ws.data.pages.filter(p => p.type === 'database').map(p => p.id))
  const run = (action: () => Promise<unknown>) => {
    void action().catch(() => ws.notify(t('Could not complete the action. Please try again.')))
  }
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    ws.notify(t('Copied'))
  }
  const exportPage = async (id: string) => {
    const md = await ws.markdownOf(id)
    download(new TextEncoder().encode(md.text), md.path.split('/').pop() || 'page.md', 'text/markdown')
  }
  const copyPageLink = (id: string) => copy(new URL(href({ name: 'page', id }), location.href).href)
  const organizeItems = (page: Page): MenuItem[] => [
    { label: 'Rename', testid: 'menu-rename', icon: <Icon name="pencil" size={16} />, onSelect: () => setRenaming(page) },
    ...(!databases.has(page.id) && page.kind !== 'folder' ? [{ label: 'Duplicate', testid: 'menu-duplicate', icon: <Icon name="copy" size={16} />, onSelect: () => run(async () => {
      const id = uuidv7()
      await ws.duplicatePage(page.id, page.parentId ?? '', id)
      const title = ws.data.pages.find(p => p.id === id)?.title
      if (title) await ws.rename(id, title + ' ' + t('(copy)'))
      open(id)
    }) }] : []),
    { label: 'Move page', testid: 'menu-move', icon: <Icon name="folder" size={16} />, onSelect: () => { setQuery(''); setMoving(page.id) } },
    ...(page.parentId ? [{ label: 'Move to top level', testid: 'menu-move-root', icon: <Icon name="arrow-up" size={16} />, onSelect: () => run(() => ws.moveTo(page.id, '', ws.children('').length)) }] : []),
    { label: 'Copy link', testid: 'menu-copy-link', icon: <Icon name="link" size={16} />, onSelect: () => run(() => copyPageLink(page.id)) },
    { label: 'Copy title', testid: 'menu-copy-title', icon: <Icon name="clipboard" size={16} />, onSelect: () => run(() => copy(page.title)) },
    ...(!databases.has(page.id) && page.kind !== 'folder' ? [{ label: 'Export Markdown', testid: 'menu-export-md', icon: <Icon name="markdown" size={16} />, onSelect: () => run(() => exportPage(page.id)) }] : []),
  ]
  const shareItems = (id: string): MenuItem[] => [
    { kind: 'head', label: 'Export' },
    { label: 'Markdown file', testid: 'share-markdown', hint: '.md', icon: <Icon name="download" size={16} />, onSelect: () => run(() => exportPage(id)) },
    { label: 'PDF or print', icon: <Icon name="printer" size={16} />, onSelect: () => window.print() },
    { kind: 'sep' },
    { kind: 'head', label: 'Copy' },
    { label: 'Copy as Markdown', testid: 'share-copy-markdown', icon: <Icon name="copy" size={16} />, onSelect: () => run(async () => copy((await ws.markdownOf(id)).text)) },
    { label: 'Copy link', testid: 'share-copy-link', icon: <Icon name="link" size={16} />, onSelect: () => run(() => copyPageLink(id)) },
    { kind: 'sep' },
    { label: 'Export the whole workspace', testid: 'share-workspace', hint: '.zip', icon: <Icon name="vault" size={16} />, onSelect: () => run(async () => download(await ws.exportMarkdown(), 'nevis-markdown.zip')) },
  ]
  const destinations = moving ? pages.filter(p => ws.tree.byId.has(p.id) && !databases.has(p.id) && p.id !== moving && !isInside(ws.tree, moving, p.id) && p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : []
  const move = async (parent: string) => {
    if (!moving || busy) return
    setBusy(true)
    try {
      if (await ws.moveTo(moving, parent, ws.children(parent).length)) setMoving(null)
      else ws.notify(t('Could not complete the action. Please try again.'))
    } catch { ws.notify(t('Could not complete the action. Please try again.')) }
    finally { setBusy(false) }
  }
  const dialogs = <>
    {folderParent !== null && <NameDialog title={t('New folder')} label={t('Folder name')} initial={t('New folder')} action={t('Create')}
      onSubmit={value => run(async () => reveal(await ws.newFolder(folderParent, value || t('Untitled folder'))))} onClose={() => setFolderParent(null)} />}
    {renaming && <NameDialog title={t('Rename')} label={t('New name:')} initial={renaming.title} action={t('Save')}
      onSubmit={value => run(() => ws.rename(renaming.id, value))} onClose={() => setRenaming(null)} />}
    {moving && <Dialog open title={t('Move page')} onClose={() => { if (!busy) setMoving(null) }}>
      <div className="ds-modal-body">
        <input className="ds-field" aria-label={t('Choose a destination')} placeholder={t('Filter pages')} value={query} onChange={e => setQuery(e.target.value)} />
        <fieldset className="ds-list ds-list--framed page-destinations" aria-label={t('Choose a destination')} aria-busy={busy} disabled={busy}>
          <Row as="button" className="ds-list-row" data-testid="move-root" text={t('Move to top level')} icon={<Icon name="book" size={16} />} onClick={() => void move('')} />
          {destinations.slice(0, 200).map(p => <Row as="button" key={p.id} className="ds-list-row" data-testid="move-destination" data-id={p.id} text={p.title || t('Untitled')} icon={<Icon name="file" size={16} />} onClick={() => void move(p.id)} />)}
        </fieldset>
        {destinations.length > 200 && <p className="small">{t('Search to narrow the destinations.')}</p>}
      </div>
    </Dialog>}
  </>
  return { organizeItems, shareItems, dialogs, newFolder: (parent = '') => setFolderParent(parent) }
}
