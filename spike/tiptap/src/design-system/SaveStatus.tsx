import { Icon } from './icons'

/** Passive persistence feedback. The caller supplies the truthful state and translated label. */
export function SaveStatus({ state, label }: { state: 'idle' | 'saving' | 'saved' | 'error'; label: string }) {
  return <span className="ds-save-status" data-state={state} role="status" aria-live="polite" aria-atomic="true">
    <Icon name={state === 'saved' ? 'check' : state === 'error' ? 'warning' : state === 'idle' ? 'file' : 'save'} size={14} />
    <span>{label}</span>
  </span>
}
