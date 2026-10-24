// Tasks = every checklist item (taskItem) in the pages. Nothing is stored separately: this reads the page documents
// and writes a toggle straight back into the page, so the editor and the Tasks view always agree.
import { repo } from './store'
import { kvGet, kvSet } from './db'

export interface Task {
  pageId: string
  index: number // ordinal of the taskItem in its page document
  text: string
  checked: boolean
  depth: number // nesting level (0 = top level)
}

const textOf = (n: any): string => (!n ? '' : (n.text ?? (n.content ?? []).map(textOf).join('')))

/** The text of a task item = its own paragraph(s), without nested lists. */
const ownText = (item: any) =>
  (item.content ?? [])
    .filter((c: any) => c.type !== 'taskList' && c.type !== 'bulletList' && c.type !== 'orderedList')
    .map(textOf)
    .join(' ')
    .trim()

function walk(node: any, visit: (item: any, depth: number) => void, depth = 0) {
  if (!node || typeof node === 'string') return
  const isItem = node.type === 'taskItem'
  if (isItem) visit(node, depth)
  for (const c of node.content ?? []) walk(c, visit, isItem ? depth + 1 : depth)
}

export function tasksOf(pageId: string, doc: any): Task[] {
  const out: Task[] = []
  walk(doc, (item, depth) => out.push({ pageId, index: out.length, text: ownText(item), checked: !!item.attrs?.checked, depth }))
  return out
}

export function allTasks(): Task[] {
  return repo.pagesOnly().flatMap((p) => tasksOf(p.id, p.content))
}

export function setChecked(task: Task, checked: boolean) {
  const page = repo.get(task.pageId)
  if (!page) return
  const doc = structuredClone(page.content)
  let i = 0
  walk(doc, (item) => {
    if (i++ === task.index) item.attrs = { ...item.attrs, checked }
  })
  repo.update(page.id, { content: doc })
}

// ───── inbox: tasks typed straight into the Tasks view (no page of their own) ─────

export interface InboxTask {
  id: string
  text: string
  checked: boolean
}

const INBOX_KEY = 'tasksInbox'

export async function loadInbox(): Promise<InboxTask[]> {
  const v = await kvGet<InboxTask[]>(INBOX_KEY)
  return Array.isArray(v) ? v : []
}

export const saveInbox = (list: InboxTask[]) => kvSet(INBOX_KEY, list)
