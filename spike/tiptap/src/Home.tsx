import { useEffect, useMemo, useRef, useState } from 'react'
import type { Page } from './repo'
import { useSettings } from './settings'
import { tasksOf, setChecked } from './taskData'
import { countDue } from './cardsDue'
import { HomeScreen, type HomeActions } from './HomeScreen'
import { HomeNote } from './HomeNote'
import { repo } from './store'

/** Home reads the same documents and review schedule as the editor. */
export function Home({ pages, onPagesChange, ...actions }: HomeActions & { pages: Page[]; onPagesChange: () => void }) {
  const draftId = useRef<string | null>(null)
  const settings = useSettings()
  const [now, setNow] = useState(Date.now)
  const [due, setDue] = useState<number | null>(null)
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  useEffect(() => {
    let live = true
    const refresh = () => void countDue().then(n => { if (live) setDue(n) }).catch(() => undefined)
    refresh()
    window.addEventListener('cards-reviewed', refresh)
    return () => {
      live = false
      window.removeEventListener('cards-reviewed', refresh)
    }
  }, [pages, now])
  const [empty] = useState(() => !pages.some(p => !p.deletedAt && p.kind !== 'folder' && !p.database))
  const tasks = useMemo(() => pages.filter(p => !p.deletedAt && p.kind !== 'folder' && !p.database).flatMap(p => tasksOf(p.id, p.content)), [pages])
  return <HomeScreen {...actions} pages={pages} tasks={tasks} due={due} now={now} showIcons={settings.showIcons} onCheck={setChecked} draftId={draftId.current}
    note={<HomeNote autoFocus={empty} onOpen={actions.onOpen}onDirty={(id, dirty) => repo.setEditorDirty(id, dirty)} onPersist={() => repo.flushBeforeUpdate()} onChange={draft => {
      // Creation is lazy and happens once, before the first meaningful edit.
      if (!draftId.current) draftId.current = repo.create(null).id
      if (!repo.get(draftId.current) || repo.get(draftId.current)?.deletedAt) throw new Error('Draft page unavailable')
      repo.update(draftId.current, { title: draft.title.trim() || draft.text.split('\n').find(line => line.trim())?.slice(0, 80) || '', content: draft.content })
      onPagesChange()
      return draftId.current
    }} />}
  />
}
