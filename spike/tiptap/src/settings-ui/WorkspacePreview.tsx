import { useLayoutEffect, useRef, useState } from 'react'
import { useSettings } from '../settings'
import { Icon } from '../design-system/icons'
import { SidebarSample } from './SidebarPreview'
import { useLabels } from './labels'
export function LivePreview() {
  const s = useSettings(), l = useLabels()
  const frame = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const resize = () => setScale(Math.min(1, el.clientWidth / 420))
    const observer = new ResizeObserver(resize)
    observer.observe(el); resize()
    return () => observer.disconnect()
  }, [])
  return <aside className="prefs-preview" aria-label={l('Live preview')}>
    <div className="prefs-preview-label"><span>{l('Live preview')}</span><span className="prefs-live"><i />{l('Updates instantly')}</span></div>
    <div ref={frame} className="prefs-mini-frame" style={{ height: 420 * scale }}><div className="prefs-mini" data-sidebar={s.sidebar} style={{ transform: `scale(${scale})` }}>
      <SidebarSample mode={s.sidebar} pagesView={s.pagesView} />
      <div className="prefs-mini-page">
        <div className="prefs-mini-crumb">{l('Personal space')}<span>/</span>{l('Notes')}</div>
        {s.showCovers && <div className="prefs-mini-cover" />}
        {s.showIcons && <span className="prefs-mini-icon"><Icon name="book" /></span>}
        <h3>{l('A little room to think.')}</h3>
        <p className="prefs-mini-copy">{l('Good ideas start with a clear space. Capture a thought, connect it, and make it yours.')}</p>
        <div className="prefs-mini-rule" />
        <div className="prefs-mini-task"><span className="ds-check" aria-checked="true"><Icon name="check" /></span>{l('Collect your ideas')}</div>
        <div className="prefs-mini-task"><span className="ds-check" aria-checked="false" />{l('Find the next step')}</div>
        <span className="prefs-sample-action"><Icon name="plus" />{l('New page')}</span>
      </div>
    </div>
    </div><p className="prefs-preview-hint">{l('Your content stays yours. These controls change how your workspace feels.')}</p>
  </aside>
}
