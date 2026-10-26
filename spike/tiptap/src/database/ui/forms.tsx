// Small form controls shared by the database panels (labels, segmented choice, switch, number box).
import type { ReactNode } from 'react'

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="db-field">
    <span className="db-field-l">{label}</span>
    {children}
    {hint && <small className="db-field-h">{hint}</small>}
  </label>
)

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="db-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <label className="db-switch">
    <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    <span className="db-switch-t">{label}</span>
  </label>
)
