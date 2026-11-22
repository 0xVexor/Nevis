// Home: the old HomeScreen (copied as it was) fed from the new data layer.
import { useEffect, useMemo, useState } from 'react'
import { isDue } from '@nevis/core'
import { useSettings } from '../deviceSettings'
import { go } from '../router'
import { legacyPages, legacyTasks } from '../shell/adapt'
import type { Workspace } from '../workspace'
import { HomeNote } from './HomeNote'
import { HomeScreen } from './HomeScreen'

export function HomeRoute({ ws, onOpen, onNewPage, onTemplate, onWorkspaces }: { ws: Workspace; onOpen: (id: string) => void; onNewPage: () => void; onTemplate: (id: string) => void; onWorkspaces?: () => void }) {
  const settings = useSettings()
  const pages = useMemo(() => legacyPages(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => legacyTasks(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const [due, setDue] = useState<number | null>(null)
  useEffect(() => { let live = true; void ws.reviewData().then(d => { if (live) setDue(ws.search.cards().filter(c => isDue(d.recs.get(c.id), Date.now())).length) }); return () => { live = false } }, [ws, ws.data, ws.search.ready, ws.search.progress.done])
  return (
    <div data-testid="home">
      <HomeScreen
        pages={pages} tasks={tasks} due={due} now={Date.now()} showIcons={settings.showIcons} onCheck={(task, checked) => { const blockId = ws.search.tasks().filter(x => x.page === task.pageId)[task.index]?.task.blockId; void ws.setTaskChecked(task.pageId, blockId ?? '', checked, task.index) }}
        onOpen={onOpen} onNew={onNewPage} onTable={() => go({ name: 'all' })} onCards={() => go({ name: 'cards' })} onTemplates={() => go({ name: 'templates' })} onTemplate={onTemplate}
        onImport={() => { ws.notify('یادداشت‌ها همیشه در یک فضای کار تازه وارد می‌شوند: «ورود از باندل» را در فهرست فضاهای کار بزنید.'); onWorkspaces?.() }} onFiles={() => go({ name: 'files' })} onTasks={() => go({ name: 'tasks' })}
        note={<HomeNote ws={ws} onOpen={onOpen} autoFocus={pages.filter(p => !p.deletedAt).length === 0} />}
      />
    </div>
  )
}
