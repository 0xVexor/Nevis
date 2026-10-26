// Comment thread of a row (or of one of its properties). Authorization is re-checked by the commands on every reply / edit / resolve.
import { useEffect, useState } from 'react'
import type { CommentRecord, Id } from '../model/types.ts'
import type { DatabaseService } from '../service.ts'
import { t } from '../../i18n'
import { ago } from '../../ui'
import * as Ic from '../../icons'
import { errorText } from './common'

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
    if (r.ok) { setDraft(''); setReplyTo(null); setEditing(null); setErr(null) } else setErr(errorText(r.code, r.message))
  }
  const one = (c: CommentRecord, reply = false) => {
    const author = svc.state.get('principal', c.authorId)?.displayName ?? t('Unknown person')
    return (
      <div className={'cm' + (c.resolved ? ' resolved' : '') + (reply ? ' reply' : '')} key={c.id}>
        <div className="cm-head"><b dir="auto">{author}</b><small>{ago(c.createdAt)}{c.editedAt ? ` · ${t('edited')}` : ''}</small></div>
        <div className="cm-body" dir="auto">{c.body.map((r) => r.text).join('')}</div>
        <div className="cm-acts">
          {!reply && canComment && <button type="button" onClick={() => (setReplyTo(c.id), setEditing(null))}>{t('Reply')}</button>}
          {c.authorId === svc.principalId && <button type="button" onClick={() => (setEditing(c.id), setReplyTo(null), setDraft(c.body.map((r) => r.text).join('')))}>{t('Edit')}</button>}
          {!reply && canComment && <button type="button" onClick={() => void svc.tryExec([{ type: 'comment.resolve', payload: { commentId: c.id, resolved: !c.resolved } }])}>{c.resolved ? t('Reopen') : t('Resolve')}</button>}
          {(c.authorId === svc.principalId) && <button type="button" className="danger" onClick={() => void svc.tryExec([{ type: 'comment.delete', payload: { commentId: c.id } }])}>{t('Delete')}</button>}
        </div>
        {!reply && all.filter((r) => r.parentCommentId === c.id).sort((a, b) => a.createdAt - b.createdAt).map((r) => one(r, true))}
      </div>
    )
  }
  return (
    <div className="cm-thread">
      {top.length === 0 && <div className="db-empty-hint">{t('No comments yet')}</div>}
      {top.map((c) => one(c))}
      {canComment && (
        <div className="cm-compose">
          {replyTo && <small>{t('Replying…')} <button type="button" className="db-linkbtn" onClick={() => setReplyTo(null)}>{t('Cancel')}</button></small>}
          <textarea className="db-input" rows={2} dir="auto" value={draft} placeholder={t('Write a comment…')} aria-label={t('Comment')} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() }
          }} />
          <button type="button" className="primary" onClick={() => void send()}><Ic.Arrow size={12} /> {editing ? t('Save') : t('Send')}</button>
        </div>
      )}
      {err && <div className="db-err" role="alert">{err}</div>}
    </div>
  )
}
