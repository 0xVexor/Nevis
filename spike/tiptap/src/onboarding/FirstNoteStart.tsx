import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FirstNote } from './FirstNote'
import { repo } from '../store'
import { OPEN_PAGE } from '../editor/pageLink'

// Set when the start flow creates a workspace; read once, after the reload that opens it.
const KEY = 'nevis.firstNote'
/** The mark as stored, before the workspace is loaded: enough to draw the start flow's last frame again. */
export const firstNoteMark = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
export const markFirstNote = (workspace: string) => {
  try {
    localStorage.setItem(KEY, workspace)
  } catch {
    /* without storage the workspace simply opens on Home */
  }
}
const clear = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** The workspace name when its first note is still to come; a workspace that already has pages clears the mark. */
export function pendingFirstNote(): string | null {
  const workspace = firstNoteMark()
  if (workspace === null) return null
  if (repo.pagesOnly().length) return (clear(), null)
  return workspace
}

/**
 * A new workspace's first launch: the first note in front, then the app appears behind it, opens the new page,
 * and the sheet flies into that page's row in the sidebar.
 */
export function FirstLaunch({ workspace, app }: { workspace: string; app: ReactNode }) {
  const draftId = useRef<string | null>(null)
  const [shown, setShown] = useState<'note' | 'both' | 'app'>('note')
  const [page, setPage] = useState<string | null>(null)
  // runs after the app's own effects, so it is already listening
  useEffect(() => {
    if (shown === 'both' && page) window.dispatchEvent(new CustomEvent(OPEN_PAGE, { detail: page }))
  }, [shown, page])
  return (
    <>
      {shown !== 'note' && app}
      {shown !== 'app' && (
        <FirstNote
          workspace={workspace}
          arrive
          onChange={(draft) => {
            if (!draftId.current) draftId.current = repo.create(null).id
            if (!repo.get(draftId.current) || repo.get(draftId.current)?.deletedAt) throw new Error('Draft page unavailable')
            repo.update(draftId.current, { title: draft.title.trim() || draft.text.split('\n').find((line) => line.trim())?.slice(0, 80) || '', content: draft.content })
            return draftId.current
          }}
          onPersist={() => repo.flushBeforeUpdate()}
          onDirty={(id, dirty) => repo.setEditorDirty(id, dirty)}
          onReveal={(id) => {
            clear()
            setPage(id)
            setShown('both')
          }}
          target={() => document.querySelector('.side .row.tree.cur')}
          onFinish={() => setShown('app')}
        />
      )}
    </>
  )
}
