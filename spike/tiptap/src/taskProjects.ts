import type { PageIndex } from './pageIndex'
import type { Task } from './taskData'

/** A project is a top-level folder. Use the visible page tree so database rows do not become project sources. */
export function buildTaskProjects(index: PageIndex, tasks: Pick<Task, 'pageId' | 'checked'>[]) {
  const projectByPage = new Map<string, string>()
  const folders = (index.kids.get(null) ?? []).filter((page) => page.kind === 'folder')
  for (const folder of folders) {
    const pending = [folder]
    while (pending.length > 0) {
      const page = pending.pop()!
      if (projectByPage.has(page.id)) continue
      projectByPage.set(page.id, folder.id)
      for (const child of index.kids.get(page.id) ?? []) pending.push(child)
    }
  }

  const open = new Map<string, number>()
  for (const task of tasks) {
    if (task.checked) continue
    const projectId = projectByPage.get(task.pageId)
    if (projectId) open.set(projectId, (open.get(projectId) ?? 0) + 1)
  }

  return { projects: folders.map((folder) => ({ folder, open: open.get(folder.id) ?? 0 })), projectByPage }
}
