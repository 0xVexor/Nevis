import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Ic from './icons'
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

function Dialog({ opts, done }: { opts: Opts; done: (r: Result) => void }) {
  const [value, setValue] = useState(opts.input?.initial ?? '')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const ok = () => done(opts.input ? value : true)
  return (
    <div className="overlay dlg-overlay" onMouseDown={() => done(opts.input ? null : false)}>
      <form
        className="modal dlg"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => (e.preventDefault(), ok())}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), done(opts.input ? null : false))}
      >
        <div className="dlg-body">
          <span className={'dlg-ic' + (opts.danger ? ' danger' : '')}>{opts.danger ? <Ic.Trash size={20} /> : opts.input ? <Ic.Pencil size={20} /> : <Ic.Info size={20} />}</span>
          <div className="dlg-tx">
            <b dir="auto">{opts.title}</b>
            {opts.message && <p dir="auto">{opts.message}</p>}
            {opts.input && (
              <input ref={field} dir={opts.input.ltr ? 'ltr' : 'auto'} value={value} placeholder={opts.input.placeholder} onChange={(e) => setValue(e.target.value)} />
            )}
          </div>
        </div>
        <div className="dlg-acts">
          {!opts.alert && <button type="button" className="dlg-cancel" onClick={() => done(opts.input ? null : false)}>{t('Cancel')}</button>}
          <button type="submit" autoFocus={!opts.input} className={'primary' + (opts.danger ? ' danger' : '')}>{opts.confirmLabel ?? (opts.alert ? t('OK') : opts.input ? t('Save') : t('Continue'))}</button>
        </div>
      </form>
    </div>
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
    root!.render(<Dialog opts={opts} done={done} />)
  })
}

/** Themed replacements for window.confirm / prompt / alert. */
export const confirmDialog = async (o: Omit<Opts, 'input' | 'alert'>) => (await show(o)) === true
export const promptDialog = async (o: Omit<Opts, 'input' | 'alert'> & { initial?: string; placeholder?: string; ltr?: boolean }) =>
  (await show({ ...o, input: { initial: o.initial, placeholder: o.placeholder, ltr: o.ltr } })) as string | null
export const alertDialog = async (o: Omit<Opts, 'input' | 'alert'>) => void (await show({ ...o, alert: true }))
