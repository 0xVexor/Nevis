// Comments and feed view receipts (handoff §17.8, §22). Authorization is re-checked on every reply, edit and resolve.
import type { CommentRecord, Id, Json, RichRun } from '../model/types.ts'
import { fail } from '../model/errors.ts'
import { civilOf } from '../dates.ts'
import { isEmptyCell } from '../props/registry.ts'
import { feedViewEventId } from '../viewLogic.ts'
import { reminderEventId } from '../reminders.ts'
import { register, type Ctx } from './coordinator.ts'

const NO_COMMENT_KINDS = ['title', 'formula', 'rollup', 'button', 'unique_id']

function pageRow(cx: Ctx, pageId: Id) {
  const r = cx.d.row(pageId)
  if (!r) return fail('NOT_FOUND', 'item not found', { pageId })
  return r!
}

register('comment.add', (cx, p: { pageId: Id; propertyId?: Id | null; parentCommentId?: Id | null; body: RichRun[]; id?: Id }) => {
  const row = pageRow(cx, p.pageId)
  cx.access.assertRow(cx.env.actorId, row, 'comment')
  if (!p.body?.length || !p.body.some((r) => r.text.trim() || r.mention)) fail('INVALID_VALUE', 'a comment cannot be empty')
  if (p.propertyId) {
    const def = cx.d.prop(p.propertyId)
    if (!def || def.sourceId !== row.sourceId) fail('NOT_FOUND', 'property not found')
    if (NO_COMMENT_KINDS.includes(def!.kind)) fail('INVALID_VALUE', `${def!.kind} properties cannot be commented`)
    if (def!.kind === 'checkbox') fail('INVALID_VALUE', 'comment on a checkbox through the page property editor')
    if (!cx.access.canReadProperty(cx.env.actorId, def!, row)) fail('ACCESS_DENIED', 'you cannot see this property')
    const c = row.ext.cells[def!.id]?.value
    if (!c || isEmptyCell(c)) fail('INVALID_VALUE', 'an empty property cannot be commented')
  }
  if (p.parentCommentId) {
    const parent = cx.d.get('comment', p.parentCommentId)
    if (!parent || parent.deletedAt !== null || parent.pageId !== p.pageId) fail('NOT_FOUND', 'the comment you reply to is gone')
  }
  const rec: CommentRecord = { ...cx.meta(p.id), pageId: p.pageId, propertyId: p.propertyId ?? null, parentCommentId: p.parentCommentId ?? null, authorId: cx.env.actorId, body: p.body, resolved: false, editedAt: null, readBy: [cx.env.actorId] }
  cx.d.add('comment', rec)
  return { commentId: rec.id }
})

register('comment.edit', (cx, p: { commentId: Id; body: RichRun[] }) => {
  const c = cx.d.get('comment', p.commentId)
  if (!c || c.deletedAt !== null) fail('NOT_FOUND', 'comment not found')
  if (c!.authorId !== cx.env.actorId) fail('ACCESS_DENIED', 'only the author can edit a comment')
  cx.access.assertRow(cx.env.actorId, pageRow(cx, c!.pageId), 'comment')
  const m = cx.d.mut('comment', c!.id)
  m.body = p.body
  m.editedAt = cx.now
})

register('comment.resolve', (cx, p: { commentId: Id; resolved: boolean }) => {
  const c = cx.d.get('comment', p.commentId)
  if (!c || c.deletedAt !== null) fail('NOT_FOUND', 'comment not found')
  cx.access.assertRow(cx.env.actorId, pageRow(cx, c!.pageId), 'comment')
  cx.d.mut('comment', c!.id).resolved = p.resolved
})

register('comment.delete', (cx, p: { commentId: Id }) => {
  const c = cx.d.get('comment', p.commentId)
  if (!c || c.deletedAt !== null) return
  const row = pageRow(cx, c.pageId)
  if (c.authorId !== cx.env.actorId) cx.access.assertRow(cx.env.actorId, row, 'manage')
  cx.d.mut('comment', c.id).deletedAt = cx.now // soft delete: history keeps it
})

register('comment.read', (cx, p: { commentIds: Id[] }) => {
  for (const id of p.commentIds) {
    const c = cx.d.get('comment', id)
    if (c && c.deletedAt === null && !c.readBy.includes(cx.env.actorId)) cx.d.mut('comment', id).readBy.push(cx.env.actorId)
  }
})

/** One view per principal / page / day. `who` is the principal id, or a local anonymous id for private use. */
/** Receipt of a fired reminder: one per person, page, property, offset and date value. Firing the same one twice changes nothing. */
register('reminder.fire', (cx, p: { pageId: Id; propertyId: Id; offsetMinutes: number; startKey: string }) => {
  const row = pageRow(cx, p.pageId)
  cx.access.assertRow(cx.env.actorId, row, 'read')
  const id = reminderEventId(cx.env.actorId, p.pageId, p.propertyId, p.offsetMinutes, p.startKey)
  if (cx.d.get('event', id)) return { fired: false }
  cx.d.add('event', { ...cx.meta(id), type: 'reminder', pageId: p.pageId, principalId: cx.env.actorId, data: { propertyId: p.propertyId, offsetMinutes: p.offsetMinutes, startKey: p.startKey } as Json })
  return { fired: true }
})

register('feed.view', (cx, p: { pageId: Id; who?: Id; visibleMs: number; zone?: string }) => {
  if (p.visibleMs < 2000) return { counted: false } // must have been visible for 2 seconds
  const row = pageRow(cx, p.pageId)
  cx.access.assertRow(cx.env.actorId, row, 'read')
  const who = p.who ?? cx.env.actorId
  const id = feedViewEventId(p.pageId, who, civilOf(cx.now, p.zone ?? 'UTC'))
  if (cx.d.get('event', id)) return { counted: false }
  cx.d.add('event', { ...cx.meta(id), type: 'view', pageId: p.pageId, principalId: who, data: null as Json })
  return { counted: true }
})
