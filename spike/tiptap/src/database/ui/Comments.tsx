// Comment thread of a row (or of one of its properties). Authorization is re-checked by the commands on every reply / edit / resolve.
import { useEffect, useState } from 'react'
import type { CommentRecord, Id } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { Button, Icon } from '../../design-system'
import { shortcutLabel } from '../../shortcuts'
import { t } from '../../i18n'
import { ago } from '../../ui'
import { ErrorLine, Hint, errorText } from './common'

export function CommentsThread({ svc, pageId, propertyId }: { svc: DatabaseService; pageId: Id; propertyId: Id | null }) {
  const all = svc.state.live('comment').filter((c) => c.pageId === pageId && c.propertyId === propertyId)
  const top = all.filter((c) => c.parentCommentId === null).sort((a, b) => a.createdAt - b.createdAt)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<Id | null>(null)
  const [editing, setEditing] = useState<Id | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const canComment = svc.access().rowCaps(svc.principalId, svc.state.row(pageId)!).has('comment')
  useEffect(() => {
    const unread = all.filter((c) => !c.readBy.includes(svc.principalId)).map((c) => c.id)
    if (unread.length) void svc.tryExec([{ type: 'comment.read', payload: { commentIds: unread } }])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length])
  const send = async () => {
    const text = draft.trim()
    if (!text) return
    const r = editing
      ? await svc.tryExec([{ type: 'comment.edit', payload: { commentId: editing, body: [{ text }] } }])
      : await svc.tryExec([{ type: 'comment.add', payload: { pageId, propertyId, parentCommentId: replyTo, body: [{ text }] } }])
    if (r.ok) {
      setDraft('')
      setReplyTo(null)
      setEditing(null)
      setErr(null)
    } else setErr(errorText(r.code, r.message))
  }
  const one = (c: CommentRecord, reply = false) => {
    const author = svc.state.get('principal', c.authorId)?.displayName ?? t('Unknown person')
    const mine = c.authorId === svc.principalId
    return (
      <article className="dv-comment" data-resolved={c.resolved || undefined} data-reply={reply || undefined} key={c.id}>
        <header className="dv-comment-head">
          <b dir="auto">{author}</b>
          <small>
            {ago(c.createdAt)}
            {c.editedAt ? ` · ${t('edited')}` : ''}
            {c.resolved ? ` · ${t('resolved')}` : ''}
          </small>
        </header>
        <p className="dv-comment-body" dir="auto">
          {c.body.map((r) => r.text).join('')}
        </p>
        <div className="dv-comment-acts">
          {!reply && canComment && (
            <Button size="sm" variant="ghost" onClick={() => (setReplyTo(c.id), setEditing(null))}>
              {t('Reply')}
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="ghost" onClick={() => (setEditing(c.id), setReplyTo(null), setDraft(c.body.map((r) => r.text).join('')))}>
              {t('Edit')}
            </Button>
          )}
          {!reply && canComment && (
            <Button size="sm" variant="ghost" onClick={() => void svc.tryExec([{ type: 'comment.resolve', payload: { commentId: c.id, resolved: !c.resolved } }])}>
              {c.resolved ? t('Reopen') : t('Resolve')}
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="ghost" className="dv-danger" onClick={() => void svc.tryExec([{ type: 'comment.delete', payload: { commentId: c.id } }])}>
              {t('Delete')}
            </Button>
          )}
        </div>
        {!reply &&
          all
            .filter((r) => r.parentCommentId === c.id)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => one(r, true))}
      </article>
    )
  }
  return (
    <div className="dv-comments">
      {top.length === 0 && <Hint>{t('No comments yet')}</Hint>}
      {top.map((c) => one(c))}
      {canComment && (
        <div className="dv-compose">
          {(replyTo || editing) && (
            <p className="dv-hint">
              {editing ? t('Editing your comment') : t('Replying…')}{' '}
              <Button size="sm" variant="ghost" onClick={() => (setReplyTo(null), setEditing(null), setDraft(''))}>
                {t('Cancel')}
              </Button>
            </p>
          )}
          <textarea
            className="ds-field"
            rows={2}
            dir="auto"
            value={draft}
            placeholder={t('Write a comment…')}
            aria-label={t('Comment')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="dv-compose-foot">
            <span className="dv-hint">{shortcutLabel(['Mod', 'Enter'])}</span>
            <Button size="sm" variant="primary" icon={<Icon name="arrow-up" size={15} />} disabled={!draft.trim()} onClick={() => void send()}>
              {editing ? t('Save') : t('Send')}
            </Button>
          </div>
        </div>
      )}
      {err && <ErrorLine>{err}</ErrorLine>}
    </div>
  )
}
