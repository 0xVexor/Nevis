import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Dialog } from './overlay'
import { FormField } from './Panel'
import { t } from './text'

/** A small dialog that asks for one name (new folder, rename). Enter confirms, Escape or a click outside cancels. Labels are translated. */
export function NameDialog({ title, label, initial, action, onSubmit, onClose }: { title: string; label: string; initial: string; action: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const submit = () => (onSubmit(value.trim()), onClose())
  // Dialog focuses the first control, which is the name field
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" type="submit" form="name-dialog">
            {action}
          </Button>
        </>
      }
    >
      <form id="name-dialog" className="ds-modal-body" onSubmit={(e) => (e.preventDefault(), submit())}>
        <FormField label={label}>
          <input ref={ref} className="ds-field" aria-label={label} dir="auto" value={value} onChange={(e) => setValue(e.target.value)} />
        </FormField>
      </form>
    </Dialog>
  )
}
