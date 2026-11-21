// Home: the old HomeScreen (copied as it was) fed from the new data layer.
import { useMemo } from 'react'
import { Button } from '../ds'
import { t } from '../i18n'
import { go } from '../router'
import { legacyPages, legacyTasks } from '../shell/adapt'
import type { Workspace } from '../workspace'
import { HomeScreen } from './HomeScreen'

export function HomeRoute({ ws, onOpen, onNewPage, onTemplate }: { ws: Workspace; onOpen: (id: string) => void; onNewPage: () => void; onTemplate: (id: string) => void }) {
  const pages = useMemo(() => legacyPages(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => legacyTasks(ws), [ws.data, ws.search.ready, ws.search.progress.done]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="home">
      <HomeScreen
        pages={pages} tasks={tasks} due={null} now={Date.now()} showIcons onCheck={() => ws.notify('برای تیک زدن کار، صفحهٔ آن را باز کنید')}
        onOpen={onOpen} onNew={onNewPage} onTable={() => go({ name: 'all' })} onCards={() => ws.notify('فلش‌کارت در مرحلهٔ بعد می‌آید')} onTemplates={() => go({ name: 'templates' })} onTemplate={onTemplate}
        onImport={() => ws.notify('ورود یادداشت‌ها در مرحلهٔ بعد می‌آید')} onFiles={() => go({ name: 'all' })} onTasks={() => go({ name: 'tasks' })}
        note={<div className="home-note-stub"><Button variant="primary" data-testid="home-new-page" onClick={onNewPage}>{t('New page')}</Button></div>}
      />
    </div>
  )
}
