import { useEffect, useState } from 'react'
import { Icon, IconButton, useMenu, type MenuItem } from './design-system'
import { bindingHint } from './shortcutBindings'
import { t } from './i18n'

export type ReaderCfg = { scale: number; width: number }
const READER_DEFAULT: ReaderCfg = { scale: 1, width: 760 }
/** Reading widths offered in the menu; a width saved by the older slider still reads fine and shows as "Custom". */
const WIDTHS = [
  { label: 'Narrow', width: 600 },
  { label: 'Comfortable', width: 760 },
  { label: 'Wide', width: 960 },
  { label: 'Full width', width: 1400 },
]

export function loadReaderCfg(): ReaderCfg {
  try {
    return { ...READER_DEFAULT, ...JSON.parse(localStorage.getItem('not.reader.cfg') || '{}') }
  } catch {
    return READER_DEFAULT
  }
}

/**
 * Reader mode chrome: a thin progress line at the top and one quiet strip at the bottom, the same strip as the formatting bar
 * (design-system icon buttons; contents and page width are menus; where you are, as plain text).
 */
export function ReaderBar({ cfg, onCfg, onExit }: { cfg: ReaderCfg; onCfg: (c: ReaderCfg) => void; onExit: () => void }) {
  const [pct, setPct] = useState(0)
  const [mins, setMins] = useState(0)
  const { open, menu } = useMenu()

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

  // the page's headings; deeper levels are set in by a thin indent
  const contents = (): MenuItem[] => {
    const heads = [...document.querySelectorAll<HTMLElement>('.tiptap h1, .tiptap h2, .tiptap h3')].map((el) => ({ el, text: el.textContent?.trim() ?? '', level: Number(el.tagName[1]) })).filter((h) => h.text)
    if (!heads.length) return [{ kind: 'head', label: 'No headings in this page' }]
    return heads.map((h) => ({ label: ' '.repeat(h.level - 1) + h.text, raw: true, onSelect: () => h.el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }))
  }
  const widths = (): MenuItem[] => WIDTHS.map((w) => ({ label: w.label, checked: cfg.width === w.width, onSelect: () => set({ width: w.width }) }))
  const set = (patch: Partial<ReaderCfg>) => onCfg({ ...cfg, ...patch })
  const step = (d: number) => set({ scale: Math.min(1.8, Math.max(0.8, Math.round((cfg.scale + d) * 10) / 10)) })

  return (
    <div className="reader-chrome">
      <div className="reader-progress" role="progressbar" aria-label={t('Reading progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ inlineSize: `${pct}%` }} />
      </div>
      <div className="reader-bar" role="toolbar" aria-label={t('Reader mode')}>
        <IconButton label={t('Exit reading') + '  Esc · ' + bindingHint('reader')} onClick={onExit}>
          <Icon name="x" size={16} />
        </IconButton>
        <span className="reader-sep" aria-hidden="true" />
        <IconButton label={t('Contents')} onClick={(e) => open(contents(), e.currentTarget)}>
          <Icon name="list" size={16} />
        </IconButton>
        <IconButton className="reader-menu" label={t('Page width')} aria-haspopup="menu" onClick={(e) => open(widths(), e.currentTarget)}>
          <Icon name="columns" size={16} />
          <Icon name="chevron-down" size={10} />
        </IconButton>
        <span className="reader-sep" aria-hidden="true" />
        <IconButton label={t('Smaller text')} disabled={cfg.scale <= 0.8} onClick={() => step(-0.1)}>
          <span className="reader-a reader-a--sm">A</span>
        </IconButton>
        <output className="reader-value" aria-label={t('Text size')}>
          {Math.round(cfg.scale * 100)}%
        </output>
        <IconButton label={t('Larger text')} disabled={cfg.scale >= 1.8} onClick={() => step(0.1)}>
          <span className="reader-a reader-a--lg">A</span>
        </IconButton>
        <span className="reader-sep" aria-hidden="true" />
        <span className="reader-meta">
          {pct}% · {t('{n} min read', { n: mins })}
        </span>
      </div>
      {menu}
    </div>
  )
}
