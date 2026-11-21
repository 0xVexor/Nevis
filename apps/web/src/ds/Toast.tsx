import { useEffect } from 'react'
import { Button } from './Button'
import { Icon } from './icons'

/**
 * The app's one toast: what just happened, in the past tense, and at most one follow-up (Undo, Show it). It closes itself
 * after `timeout` ms. `actionHint` is the shortcut shown in the action's tooltip ("Ctrl+Z" for Undo). Text is translated.
 */
export function Toast({ msg, action, actionHint, onAction, onClose, timeout = 7000 }: { msg: string; action?: string; actionHint?: string; onAction?: () => void; onClose: () => void; timeout?: number }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, timeout)
    return () => window.clearTimeout(id)
  }, [msg, onClose, timeout])
  return (
    <div className="ds-toast ds-toast--app" role="status">
      <Icon name="check" size={16} />
      <span dir="auto">{msg}</span>
      {action && (
        <Button size="sm" variant="ghost" onClick={() => (onAction?.(), onClose())} title={actionHint ? `${action}  ${actionHint}` : action}>
          {action}
        </Button>
      )}
    </div>
  )
}
