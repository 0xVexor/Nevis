import type { ReactNode } from 'react'
import { IconButton } from './Button'
import { Icon } from './icons'
import './window-title-bar.css'

export function WindowTitleBar({ title, mark, labels, maximized, draggable, onMinimize, onToggleMaximize, onClose }: {
  title: string
  mark: ReactNode
  labels: { minimize: string; maximize: string; restore: string; close: string }
  maximized: boolean
  draggable?: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  return (
    <div className="ds-window-bar">
      <div className="ds-window-drag" data-tauri-drag-region={draggable ? '' : undefined}>
        <span className="ds-window-identity" dir="auto">{mark}<span>{title}</span></span>
      </div>
      <div className="ds-window-actions">
        <IconButton label={labels.minimize} onClick={onMinimize}><Icon name="minus" size={16} /></IconButton>
        <IconButton label={maximized ? labels.restore : labels.maximize} onClick={onToggleMaximize}>
          <Icon name={maximized ? 'copy' : 'square'} size={15} />
        </IconButton>
        <IconButton className="ds-window-close" label={labels.close} onClick={onClose}><Icon name="x" size={16} /></IconButton>
      </div>
    </div>
  )
}
