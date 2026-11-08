import type { ReactNode } from 'react'

/** Product identity slot shared by workspace and preferences; no app services. */
export function WorkspaceHeader({ mark, name, action, revealLabel, expanded, pressed, onReveal, onActivate }: {
  mark: ReactNode
  name: ReactNode
  action?: ReactNode
  revealLabel?: string
  expanded?: boolean
  pressed?: boolean
  onReveal?: () => void
  onActivate?: () => void
}) {
  return <div className="ds-workspace-header">
    {onReveal || onActivate ? <button className="ds-workspace-mark" type="button" aria-label={revealLabel} title={revealLabel} aria-expanded={expanded} aria-pressed={pressed} onPointerEnter={onReveal} onFocus={onReveal} onClick={onActivate ?? onReveal}>{mark}</button> : <span className="ds-workspace-mark">{mark}</span>}
    <div className="ds-workspace-name">{name}</div>
    {action && <div className="ds-workspace-action">{action}</div>}
  </div>
}
