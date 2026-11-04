import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { BrandMark } from './BrandMark'
import { isTauri } from './db'
import { WindowTitleBar } from './design-system/WindowTitleBar'
import { useSettings } from './settings'
import { t } from './i18n'

const customTitleBar = isTauri && /Windows/i.test(navigator.userAgent)

export function DesktopFrame({ children }: { children: ReactNode }) {
  useSettings()
  const [ready, setReady] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!customTitleBar) return
    const window = getCurrentWindow()
    let active = true
    const sync = async () => {
      const [max, full] = await Promise.all([window.isMaximized(), window.isFullscreen()])
      if (active) {
        setMaximized(max)
        setFullscreen(full)
      }
    }
    const unlisten = window.onResized(() => void sync().catch(console.error))
    void unlisten.then(async () => {
      await sync()
      if (!active) return
      await window.setDecorations(false)
      if (active) setReady(true)
    }).catch(console.error)
    return () => {
      active = false
      void unlisten.then(dispose => dispose()).catch(console.error)
    }
  }, [])

  if (!customTitleBar) return children
  const window = getCurrentWindow()
  return (
    <div className="desktop-frame">
      {ready && !fullscreen && (
        <WindowTitleBar
          title="Nevis"
          mark={<BrandMark />}
          labels={{ minimize: t('Minimize window'), maximize: t('Maximize window'), restore: t('Restore window'), close: t('Close window') }}
          maximized={maximized}
          draggable
          onMinimize={() => void window.minimize().catch(console.error)}
          onToggleMaximize={() => void window.toggleMaximize().catch(console.error)}
          onClose={() => void window.close().catch(console.error)}
        />
      )}
      <div className="desktop-content">{children}</div>
    </div>
  )
}
