import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from './design-system'
import { createRoot, type Root } from 'react-dom/client'
import { t } from './i18n'

interface Opts {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  /** prompt: show a text field with this initial value */
  input?: { initial?: string; placeholder?: string; ltr?: boolean }
  /** alert: only an OK button */
  alert?: boolean
}
type Result = boolean | string | null

let root: Root | null = null
let host: HTMLElement | null = null

function QuickDialog({ opts, done }: { opts: Opts; done: (r: Result) => void }) {
  const [value, setValue] = useState(opts.input?.initial ?? '')
  const field = useRef<HTMLInputElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const cancel = () => done(opts.input ? null : false)
  const ok = () => done(opts.input ? value : true)
  // the design-system Dialog focuses its first control; here Enter answers the question, so the field or the confirm button takes focus
  useEffect(() => {
    const id = setTimeout(() => {
      if (opts.input) (field.current?.focus(), field.current?.select())
      else confirm.current?.focus()
    })
    return () => clearTimeout(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open
      title={opts.title}
      onClose={cancel}
      actions={
        <>
          {!opts.alert && <Button onClick={cancel}>{t('Cancel')}</Button>}
          <Button ref={confirm} type="submit" form="quick-dialog" variant={opts.danger ? 'danger' : 'primary'}>
            {opts.confirmLabel ?? (opts.alert ? t('OK') : opts.input ? t('Save') : t('Continue'))}
          </Button>
        </>
      }
    >
      <form id="quick-dialog" className="ds-modal-body ds-stack" onSubmit={(e) => (e.preventDefault(), ok())}>
        {opts.message && <p dir="auto">{opts.message}</p>}
        {opts.input && <input ref={field} className="ds-field" aria-label={opts.title} dir={opts.input.ltr ? 'ltr' : 'auto'} value={value} placeholder={opts.input.placeholder} onChange={(e) => setValue(e.target.value)} />}
      </form>
    </Dialog>
  )
}

function show(opts: Opts): Promise<Result> {
  if (!host) {
    host = document.createElement('div')
    host.id = 'dialog-root'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  return new Promise((resolve) => {
    const done = (r: Result) => {
      root!.render(null)
      resolve(r)
    }
    root!.render(<QuickDialog opts={opts} done={done} />)
  })
}

/** Themed replacements for window.confirm / prompt / alert. */
export const confirmDialog = async (o: Omit<Opts, 'input' | 'alert'>) => (await show(o)) === true
export const promptDialog = async (o: Omit<Opts, 'input' | 'alert'> & { initial?: string; placeholder?: string; ltr?: boolean }) =>
  (await show({ ...o, input: { initial: o.initial, placeholder: o.placeholder, ltr: o.ltr } })) as string | null
export const alertDialog = async (o: Omit<Opts, 'input' | 'alert'>) => void (await show({ ...o, alert: true }))
