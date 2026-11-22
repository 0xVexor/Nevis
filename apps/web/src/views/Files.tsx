// Files: the old app's file manager (list and grid, path bar, multi-select, cut/copy/paste, rename, drag into a page), over the page tree.
// Here a page that holds other pages plays the folder. The old calls are answered by the workspace; each is written asynchronously.
import { useMemo } from 'react'
import { createPage } from '@nevis/core'
import { Explorer, type FileOps } from '../shell/Explorer'
import { legacyPages } from '../shell/adapt'
import { go } from '../router'
import { t } from '../i18n'
import type { Page } from '../shell/model'
import type { Workspace } from '../workspace'
import { showToast } from '../toast'

export function Files({ ws, initialFolder }: { ws: Workspace; initialFolder?: string }) {
  const pages = useMemo(() => legacyPages(ws).filter(p => !p.deletedAt), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const stub = (id: string, parent: string | null): Page => ({ id, parentId: parent, title: '', favorite: false, sort: 0, content: null, updatedAt: Date.now(), deletedAt: null })
  const ops: FileOps = {
    rename: (id, title) => ws.setTitle(id, title),
    create: async (parent, kind) => { const id = kind === 'folder' ? await ws.newFolder(parent ?? '', t('New folder')) : await ws.newPage(parent ?? '', ''); return { ...stub(id, parent), kind } },
    remove: id => void ws.trash(id),
    restore: id => void ws.restore(id),
    move: (id, parent, before) => {
      const sibs = ws.children(parent ?? '').map(n => n.page.id).filter(x => x !== id)
      void ws.moveTo(id, parent ?? '', before ? Math.max(0, sibs.indexOf(before)) : sibs.length)
      return true
    },
    duplicate: (id, parent) => {
      const nid = ws.rt.client.newIdFor()
      void ws.duplicatePage(id, parent ?? '', nid)
      return stub(nid, parent)
    },
  }
  return <div data-testid="files" style={{ display: 'contents' }}><Explorer key={initialFolder ?? 'root'} initialFolder={initialFolder} pages={pages} ops={ops} onOpen={id => go({ name: 'page', id })} onChange={() => undefined} onToast={(msg, undo) => showToast(msg, undo)} /></div>
}
