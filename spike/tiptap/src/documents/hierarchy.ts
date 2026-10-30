import type { Page } from './model.ts'
import { canonicalDocumentValue } from './revision.ts'
import { DocumentPlanError } from './editPlanner.ts'

export interface CreationPosition {
  parentId: string | null
  ancestors: { id: string; parentId: string | null; deletedAt: number | null }[]
  siblings: { id: string; sort: number }[]
}
/** Match UI append ordering, including trashed siblings, without changing any sibling. */
export function creationPosition(pages: Page[], parentId: string | null) {
  const index = new Map(pages.map(page => [page.id, page])), ancestors: CreationPosition['ancestors'] = [], seen = new Set<string>()
  let id = parentId
  while (id !== null) {
    const parent = index.get(id)
    if (!parent || parent.deletedAt !== null || seen.has(id) || ancestors.length >= 128) throw new DocumentPlanError('INVALID_TARGET')
    if (parent.parentId !== null && typeof parent.parentId !== 'string') throw new DocumentPlanError('CAPABILITY_UNAVAILABLE')
    seen.add(id); ancestors.push({ id, parentId: parent.parentId, deletedAt: parent.deletedAt }); id = parent.parentId
  }
  const siblings = pages.filter(page => page.parentId === parentId).map(page => ({ id: page.id, sort: page.sort }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (siblings.some(page => !Number.isSafeInteger(page.sort))) throw new DocumentPlanError('CAPABILITY_UNAVAILABLE')
  const sort = siblings.length ? siblings.reduce((max, page) => Math.max(max, page.sort), -Infinity) + 1 : 0
  if (!Number.isSafeInteger(sort)) throw new DocumentPlanError('CAPABILITY_UNAVAILABLE')
  return { sort, precondition: { parentId, ancestors, siblings } satisfies CreationPosition }
}
export function assertCreationPosition(pages: Page[], after: Page, expected: CreationPosition) {
  try {
    const actual = creationPosition(pages, after.parentId)
    if (actual.sort !== after.sort || canonicalDocumentValue(actual.precondition) !== canonicalDocumentValue(expected)) throw new Error('changed')
  } catch { throw new Error('Document revision conflict') }
}
