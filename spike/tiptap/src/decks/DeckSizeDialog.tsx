import { useId, useState } from 'react'
import { Button, Dialog, Field, FormField } from '../design-system'
import { t } from '../i18n'
import { deckSizePresets, validDeckSize, type DeckSize } from './model'

export function DeckSizeDialog({ size, onClose, onApply }: { size: DeckSize; onClose: () => void; onApply: (size: DeckSize) => void }) {
  const formId = useId()
  const [width, setWidth] = useState(String(size.width))
  const [height, setHeight] = useState(String(size.height))
  const next = { width: Number(width), height: Number(height) }
  const valid = validDeckSize(next)

  return (
    <Dialog
      open
      title={t('Slide size')}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} disabled={!valid}>{t('Apply slide size')}</Button>
        </>
      }
    >
      <form
        id={formId}
        className="ds-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) onApply(next)
        }}
      >
        <p>{t('This size applies to every slide. Review your slides after resizing, since content can wrap differently.')}</p>
        <div className="deck-actions" role="group" aria-label={t('Slide size presets')}>
          {deckSizePresets.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              aria-pressed={next.width === preset.width && next.height === preset.height}
              onClick={() => {
                setWidth(String(preset.width))
                setHeight(String(preset.height))
              }}
            >
              {t(preset.label)}
            </Button>
          ))}
        </div>
        <FormField label={t('Width (px)')}>
          <Field ltr type="number" aria-label={t('Width (px)')} value={width} onChange={(event) => setWidth(event.target.value)} />
        </FormField>
        <FormField label={t('Height (px)')}>
          <Field ltr type="number" aria-label={t('Height (px)')} value={height} onChange={(event) => setHeight(event.target.value)} />
        </FormField>
        {!valid && <p role="status">{t('Use whole numbers from 240 to 8192. Neither side can be more than twice the other.')}</p>}
      </form>
    </Dialog>
  )
}
