import type { ReactNode } from 'react'

/** Product identity slot shared by workspace and preferences; no app services. */
export function WorkspaceHeader({ mark, name, action, revealLabel, expanded, onReveal, onActivate }: {
  mark: ReactNode
  name: ReactNode
  action?: ReactNode
  revealLabel?: string
  expanded?: boolean
  onReveal?: () => void
  onActivate?: () => void
}) {
  return <div className="ds-workspace-header">
    {onReveal ? <button className="ds-workspace-mark" type="button" aria-label={revealLabel} aria-expanded={expanded} onPointerEnter={onReveal} onFocus={onReveal} onClick={onActivate ?? onReveal}>{mark}</button> : <span className="ds-workspace-mark">{mark}</span>}
    <div className="ds-workspace-name">{name}</div>
    {action && <div className="ds-workspace-action">{action}</div>}
  </div>
}
