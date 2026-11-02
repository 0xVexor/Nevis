import { useId, type ReactNode } from 'react'
import { Button } from './Button'

/** Service-free preferences patterns. The consumer owns labels, values, persistence and side effects. */
export function PreferenceRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="prefs-row"><div className="prefs-row-label"><b>{label}</b>{hint && <p>{hint}</p>}</div><div className="prefs-control">{children}</div></div>
}
export function PreferenceGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return <section className="prefs-group" aria-labelledby={id}><h3 id={id}>{title}</h3>{children}</section>
}
export function SegmentedChoice<V extends string>({ label, value, items, onChange }: { label: string; value: V; items: { value: V; label: string; icon?: ReactNode }[]; onChange: (value: V) => void }) {
  return <div className="prefs-choice" role="group" aria-label={label}>{items.map(item => <Button key={item.value} variant="ghost" aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.icon}{item.label}</Button>)}</div>
}
export function RangeControl({ label, value, min, max, step = 1, onChange, unit = 'px' }: { label: string; value: number; min: number; max: number; step?: number; onChange: (next: number) => void; unit?: string }) {
  const id = useId()
  return <div className="prefs-range"><input id={id} aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /><output htmlFor={id}>{value} {unit}</output></div>
}
