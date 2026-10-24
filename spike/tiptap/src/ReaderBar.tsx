import { useEffect, useState } from 'react'
import { Popover } from './ui'
import * as Ic from './icons'
import { t } from './i18n'

export type ReaderCfg = { scale: number; width: number }
const READER_DEFAULT: ReaderCfg = { scale: 1, width: 760 }
const MIN_W = 480
const MAX_W = 1400

export function loadReaderCfg(): ReaderCfg {
  try {
    return { ...READER_DEFAULT, ...JSON.parse(localStorage.getItem('not.reader.cfg') || '{}') }
  } catch {
    return READER_DEFAULT
  }
}

/** Reader mode chrome: a thin progress line on top and a floating dock (exit, contents, text size, page width, reading time). */
export function ReaderBar({ cfg, onCfg, onExit }: { cfg: ReaderCfg; onCfg: (c: ReaderCfg) => void; onExit: () => void }) {
  const [pct, setPct] = useState(0)
  const [mins, setMins] = useState(0)
  const [toc, setToc] = useState<DOMRect | null>(null)
  const [heads, setHeads] = useState<{ el: HTMLElement; text: string; level: number }[]>([])

  useEffect(() => {
    const sc = document.querySelector('.scroller') as HTMLElement | null
    if (!sc) return
    const on = () => setPct(sc.scrollHeight <= sc.clientHeight ? 100 : Math.round((sc.scrollTop / (sc.scrollHeight - sc.clientHeight)) * 100))
    on()
    sc.addEventListener('scroll', on, { passive: true })
    return () => sc.removeEventListener('scroll', on)
  }, [])
  useEffect(() => {
    const words = (document.querySelector('.tiptap')?.textContent ?? '').trim().split(/\s+/).filter(Boolean).length
    setMins(Math.max(1, Math.round(words / 200)))
  }, [])

  const openToc = (r: DOMRect) => {
    setHeads([...document.querySelectorAll<HTMLElement>('.tiptap h1, .tiptap h2, .tiptap h3')].map((el) => ({ el, text: el.textContent?.trim() || '…', level: Number(el.tagName[1]) })).filter((h) => h.text))
    setToc(r)
  }
  const set = (patch: Partial<ReaderCfg>) => onCfg({ ...cfg, ...patch })
  const step = (d: number) => set({ scale: Math.min(1.8, Math.max(0.8, Math.round((cfg.scale + d) * 10) / 10)) })

  return (
    <div className="reader-bar" dir="auto">
      <div className="reader-prog"><i style={{ width: `${pct}%` }} /></div>
      <div className="rb-dock">
        <button className="rb-exit" onClick={onExit} title={t('Exit reader mode (Esc)')}><Ic.Close size={15} />{t('Exit reading')}</button>
        <span className="rb-div" />
        <button className="rb-icon" onClick={(e) => openToc(e.currentTarget.getBoundingClientRect())} title={t('Contents')}><Ic.List size={17} /></button>
        <div className="rb-seg" title={t('Text size')}>
          <button onClick={() => step(-0.1)} disabled={cfg.scale <= 0.8} title={t('Smaller text')}><span className="rb-a sm">A</span></button>
          <span className="rb-val">{Math.round(cfg.scale * 100)}%</span>
          <button onClick={() => step(0.1)} disabled={cfg.scale >= 1.8} title={t('Larger text')}><span className="rb-a lg">A</span></button>
        </div>
        <div className="rb-width" title={t('Page width')}>
          <Ic.Sidebar size={15} />
          <input className="rb-range" type="range" min={MIN_W} max={MAX_W} step={10} value={cfg.width} aria-label={t('Page width')} onChange={(e) => set({ width: Number(e.target.value) })} />
        </div>
        <span className="rb-div" />
        <span className="rb-meta"><b>{pct}%</b><small>{t('{n} min read', { n: mins })}</small></span>
      </div>
      {toc && (
        <Popover anchor={toc} onClose={() => setToc(null)}>
          <div className="rb-toc">
            {heads.length === 0 && <div className="empty-note">{t('No headings in this page')}</div>}
            {heads.map((h, i) => (
              <button key={i} className={'rb-toc-i l' + h.level} dir="auto" onClick={() => (h.el.scrollIntoView({ block: 'start', behavior: 'smooth' }), setToc(null))}>
                {h.text}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}
