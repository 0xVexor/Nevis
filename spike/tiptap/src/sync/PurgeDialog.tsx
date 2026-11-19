// The last question before a workspace is removed from the server for good. Nothing asks for a password: the person types the
// workspace's name instead, so that an irreversible action is a deliberate one.
import { useState, type ReactNode } from 'react'
import { Button, Dialog, Field, Notice } from '../design-system'
import { t } from '../i18n'

/** What has to be typed to confirm: the name, or (for a workspace without a name) the short ID shown next to it. */
export function purgePhrase(v: { id: string; name: string }): string {
  return v.name.trim() || t('ID {id}').replace('{id}', v.id.slice(0, 6))
}

export function PurgeDialog({ vault, tags, note, busy, error, onCancel, onConfirm }: { vault: { id: string; name: string }; tags?: ReactNode; note?: ReactNode; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('')
  const phrase = purgePhrase(vault)
  const matches = typed.trim() === phrase
  return (
    <Dialog
      open
      title={t('Delete “{name}” permanently?').replace('{name}', vault.name || phrase)}
      onClose={onCancel}
      actions={
        <>
          <Button disabled={busy} onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !matches} onClick={onConfirm}>
            {t('Delete permanently')}
          </Button>
        </>
      }
    >
      <form
        className="ds-modal-body"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && matches) onConfirm()
        }}
      >
        <p>
          <b dir="auto">{vault.name || phrase}</b> {tags}
        </p>
        <p>{t('This removes the workspace from the server for good. It cannot be undone. The files on your devices stay.')}</p>
        {note}
        <p>{t('To confirm, type this exactly:')}</p>
        <p>
          <bdi dir="auto">
            <b>{phrase}</b>
          </bdi>
        </p>
        <Field value={typed} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label={t('Type the name to confirm')} onChange={(e) => setTyped(e.target.value)} />
        {error && (
          <Notice tone="bad" role="alert">
            {error}
          </Notice>
        )}
      </form>
    </Dialog>
  )
}
