import { useEffect, useState } from 'react'
import type { Cover, Page } from './repo'
import { pickFiles } from './io'
import { putFile, urlFor } from './attachments'
import * as Ic from './icons'
import { t } from './i18n'
import { BACKGROUNDS } from './design-system/backgrounds'

/** Built-in covers: ten abstract designs, pure CSS, so they cost no storage and survive backup/restore untouched. */
const mesh = (...stops: [string, number, number][]) => stops.map(([c, x, y]) => `radial-gradient(at ${x}% ${y}%, ${c} 0, transparent 55%)`).join(', ')
const wave = (fill: string, d: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 400' preserveAspectRatio='none'%3E%3Cpath fill='${encodeURIComponent(fill)}' d='${d}'/%3E%3C/svg%3E") bottom / 100% 60% no-repeat`
const W1 = 'M0 400V260c120-80 240-80 360 0s240 80 360 0 240-80 480 20V400z'
const W2 = 'M0 400V310c150-60 300-60 450 0s300 60 450 0 200-30 300 10V400z'
const stars = 'radial-gradient(1.5px 1.5px at 12% 22%, #fff 50%, transparent), radial-gradient(1px 1px at 30% 60%, #fff 50%, transparent), radial-gradient(1.5px 1.5px at 55% 18%, #fff 50%, transparent), radial-gradient(1px 1px at 72% 48%, #fff 50%, transparent), radial-gradient(2px 2px at 88% 24%, #fff 50%, transparent), radial-gradient(1px 1px at 44% 82%, #fff 50%, transparent), radial-gradient(1px 1px at 92% 78%, #fff 50%, transparent)'

// layered silhouettes (bottom-anchored SVG polygons) over a sky gradient: the scenic covers, with no image files
const ridge = (fill: string, d: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 400' preserveAspectRatio='none'%3E%3Cpath fill='${encodeURIComponent(fill)}' d='${d}'/%3E%3C/svg%3E") bottom / 100% 70% no-repeat`
const scene = (sky: string, ...layers: [string, string][]) => [...layers.map(([f, d]) => ridge(f, d)).reverse(), sky].join(', ')
const PEAKS_A = 'M0 400V250l90-70 70 40 110-120 100 110 80-60 120 140 90-90 110 100 90-70 120 120 90-60 120 110V400z'
const PEAKS_B = 'M0 400V300l120-60 90 50 130-90 110 80 100-40 140 90 110-70 130 60 100-50 160 100V400z'
const PEAKS_C = 'M0 400V340l140-40 120 30 160-60 140 50 160-30 130 40 150-30 200 40V400z'
const PINES = 'M0 400V280l30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100 30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100 30-80 30 80 30-60 30 60 30-90 30 90 30-70 30 70 30-100 30 100 30-60 30 60 30-80 30 80 30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100V400z'

// flat colour with a small row of potted plants, drawn as inline SVG (pot tops at y=36, bottoms at y=50 of a 60-high box)
const potRow = (bg: string, w: number, pots: { x: number; art: string }[], dx = 0) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} 60'>${pots.map((p) => `<g transform='translate(${p.x + dx} 36)'>${p.art}</g>`).join('')}</svg>`)}") center 56% / auto 56% no-repeat, ${bg}`
const arms = (c: string) => `<path d='M-3.5 -6h-3a2 2 0 0 1-2-2v-5M3.5 -9h3a2 2 0 0 0 2-2v-4' stroke='${c}' stroke-width='3' fill='none' stroke-linecap='round'/>`
const terracotta = `<rect x='-3.5' y='-20' width='7' height='21' rx='3.5' fill='#7fa58f'/>${arms('#7fa58f')}<path d='M-8 0h16l-2.5 14h-11z' fill='#f0a47c'/><rect x='-9' y='-1' width='18' height='4' rx='1.2' fill='#f4b390'/>`
const concrete = `<path d='M0 0l-6-14 3 7-1-10 4 9 4-9-1 10 3-7z' fill='#3e5f52'/><path d='M0 0l-9-8 6 3-8-1 9 1-2-4zM0 0l9-8-6 3 8-1-9 1 2-4z' fill='#4d6f5f'/><rect x='-9' y='0' width='18' height='15' rx='2.5' fill='#d9d9d4'/><path d='M-9 4h18' stroke='#c4c4be' stroke-width='.8'/>`
const fabric = `<ellipse cx='0' cy='-6' rx='7' ry='9' fill='#668b72'/><path d='M-3-10v8M3-10v8M0-14v10' stroke='#86ab90' stroke-width='.8'/><circle cx='0' cy='-16' r='3.4' fill='#e6bca5'/><circle cx='0' cy='-16' r='1.2' fill='#f3dccd'/><path d='M-9 0h18v12a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4z' fill='#b9c9b5'/><circle cx='0' cy='8' r='3' fill='#f4f7f1' opacity='.9'/><circle cx='0' cy='8' r='1' fill='#e6bca5'/>`

/** The ten covers the picker offers: soft two-colour washes from the design system. */
const soft = (a: string, b: string, c?: string) => `linear-gradient(120deg, ${a}${c ? `, ${b} 55%, ${c}` : `, ${b}`})`
const PICKER: { id: string; label: string; css: string }[] = [
  { id: 'ds-lilac', label: 'Lilac', css: soft('#e7d6f7', '#bcd7f7', '#c8f0e4') },
  { id: 'ds-periwinkle', label: 'Periwinkle', css: soft('#d9e6ff', '#e4d9ff') },
  { id: 'ds-mint', label: 'Mint', css: soft('#cdeee8', '#dff3c9') },
  { id: 'ds-peach', label: 'Peach', css: soft('#ffe3c7', '#ffd3dc') },
  { id: 'ds-rose', label: 'Rose', css: soft('#ffd9e2', '#ffe9cf') },
  { id: 'ds-sage', label: 'Sage', css: soft('#cfe3d4', '#e6efd2') },
  { id: 'ds-sand', label: 'Sand', css: soft('#f1e5e3', '#e6edf2') },
  { id: 'ds-slate', label: 'Slate', css: soft('#d9e4ea', '#b9c7d6') },
  { id: 'ds-dusk', label: 'Dusk', css: soft('#3b3f6e', '#6d7fa8') },
  { id: 'ds-ink', label: 'Ink', css: soft('#2a2d4a', '#0d0e14') },
]

const GRADIENTS: { id: string; label: string; css: string }[] = [
  ...PICKER,
  { id: 'pots-blush', label: 'Blush cacti', css: potRow('#f1e5e3', 120, [30, 60, 90].map((x) => ({ x, art: terracotta }))) },
  { id: 'pots-azure', label: 'Azure succulents', css: potRow('#568bb0', 240, [128, 156, 184].map((x) => ({ x, art: concrete }))) },
  { id: 'pots-sage', label: 'Sage cacti', css: potRow('#96a693', 120, [20, 47, 74, 101].map((x) => ({ x, art: fabric }))) },
  { id: 'aurora', label: 'Aurora', css: mesh(['#ff8fd8', 10, 15], ['#7fb2ff', 88, 10], ['#a98bff', 55, 95], ['#7ff0ff', 8, 90]) + ', #5b4bd6' },
  { id: 'nebula', label: 'Nebula', css: stars + ', ' + mesh(['#b44bff', 18, 25], ['#ff4f9a', 82, 30], ['#2f6bff', 50, 100]) + ', #0b0b24' },
  { id: 'prism', label: 'Prism', css: 'conic-gradient(from 210deg at 50% 120%, #ff6ec7, #ffb86b, #fff27a, #6bf2b4, #6bb8ff, #a77bff, #ff6ec7)' },
  { id: 'liquid', label: 'Liquid', css: mesh(['#ff7a59', 14, 30], ['#ff4f9a', 60, 10], ['#8a4bff', 90, 70], ['#ffd36b', 30, 100]) + ', #ff9a7a' },
  { id: 'gridglow', label: 'Grid glow', css: 'linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px) 0 0 / 36px 36px, linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px) 0 0 / 36px 36px, ' + mesh(['#6a5cff', 50, 120], ['#19d3ff', 90, 0]) + ', #0c0d1c' },
  { id: 'waves', label: 'Waves', css: [wave('#7c5cff', W2), wave('#c06bff', W1), 'linear-gradient(180deg, #ffd1f0 0%, #b9a7ff 100%)'].join(', ') },
  { id: 'topo', label: 'Contour', css: 'repeating-radial-gradient(circle at 25% 130%, transparent 0 16px, rgba(255,255,255,0.28) 17px 18px), repeating-radial-gradient(circle at 85% -30%, transparent 0 22px, rgba(255,255,255,0.18) 23px 24px), linear-gradient(135deg, #2f9e8a, #6fd0a0)' },
  { id: 'peachmist', label: 'Peach mist', css: mesh(['#ffd1a6', 15, 20], ['#ff9fb0', 88, 25], ['#ffe9a8', 50, 95], ['#d6b8ff', 8, 85]) + ', #fff1e6' },
  { id: 'lagoon', label: 'Lagoon', css: mesh(['#2fe0c8', 10, 20], ['#2f6bff', 88, 15], ['#00b3e6', 55, 100], ['#7a5cff', 6, 90]) + ', #0b2a5a' },
  { id: 'alpenglow', label: 'Alpenglow', css: scene('linear-gradient(180deg, #5d6fb8 0%, #b987b5 40%, #ffb38a 75%, #ffd9a8 100%)', ['#3b3f6e', PEAKS_A], ['#262a52', PEAKS_B], ['#15183a', PEAKS_C]) },
  { id: 'highland', label: 'Highland', css: scene('linear-gradient(180deg, #8fb6e8 0%, #cfe0f2 55%, #f6ead9 100%)', ['#9aa9c9', PEAKS_A], ['#6d7fa8', PEAKS_B], ['#41507a', PEAKS_C]) },
  { id: 'pinewood', label: 'Pinewood', css: scene('linear-gradient(180deg, #cde9d6 0%, #8fcaa6 60%, #4f9d7b 100%)', ['#2f7a5c', PINES], ['#1c5640', PEAKS_C]) },
  { id: 'ink', label: 'Ink', css: 'conic-gradient(from 160deg at 70% 130%, #2a2d4a, #0d0e14 30%, #1c1f38 60%, #0d0e14)' },
]

// the design system's backgrounds (soft, vivid, dark, patterns, scenes) join the built-in covers; ids already present stay as they are
for (const b of BACKGROUNDS) if (!GRADIENTS.some((g) => g.id === b.id)) GRADIENTS.push({ id: b.id, label: b.label, css: b.css })

/** Covers no longer offered: pages that used them show the closest of the ten. */
const LEGACY: Record<string, string> = { sunset: 'liquid', ocean: 'lagoon', forest: 'topo', rose: 'peachmist', dusk: 'nebula', mist: 'peachmist', nightsky: 'nebula', dunes: 'peachmist', tide: 'lagoon', 'mesh-iris': 'aurora', 'mesh-peach': 'peachmist', 'mesh-mint': 'lagoon', 'mesh-ember': 'liquid', 'mesh-deep': 'lagoon', sand: 'peachmist' }
/** A cover the person made from two colours of their own is stored as `custom:#a,#b`. */
const customOf = (id: string) => {
  const m = /^custom:(#[0-9a-f]{6}),(#[0-9a-f]{6})$/i.exec(id)
  return m ? { id, label: 'Custom', css: soft(m[1], m[2]) } : null
}
const gradientOf = (id: string) => customOf(id) ?? GRADIENTS.find((g) => g.id === (LEGACY[id] ?? id)) ?? GRADIENTS.find((g) => g.id === 'aurora')!

function useCoverStyle(cover: Cover | undefined) {
  const [url, setUrl] = useState<string | null>(null)
  const file = cover?.kind === 'image' ? cover.file : null
  useEffect(() => {
    let live = true
    setUrl(null)
    if (file) void urlFor('att:' + file).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [file])
  if (!cover) return undefined
  if (cover.kind === 'gradient') return { background: gradientOf(cover.id).css }
  return url ? { backgroundImage: `url("${url}")` } : undefined
}

/** Small cover preview (Home cards); empty tinted area when the page has no cover. */
export function CoverThumb({ cover, className }: { cover: Cover | undefined; className?: string }) {
  return <div className={className} style={useCoverStyle(cover)} />
}

export function CoverBanner({ cover, onChange, onRemove }: { cover: Cover; onChange: (anchor: DOMRect) => void; onRemove: () => void }) {
  const style = useCoverStyle(cover)
  return (
    <div className="cover" style={style}>
      <div className="cover-acts">
        <button onClick={(e) => onChange(e.currentTarget.getBoundingClientRect())}>
          <Ic.Image size={15} />{t('Change cover')}
        </button>
        <button onClick={onRemove}>
          <Ic.Trash size={15} />{t('Remove')}
        </button>
      </div>
    </div>
  )
}

export function CoverPicker({ page, onPick, onClose }: { page: Page; onPick: (c: Cover | undefined) => void; onClose: () => void }) {
  const cur = page.cover
  const curId = cur?.kind === 'gradient' ? gradientOf(cur.id).id : null
  const mine = curId && /^custom:/.test(curId) ? curId.slice(7).split(',') : ['#e7d6f7', '#bcd7f7']
  const [a, setA] = useState(mine[0])
  const [b, setB] = useState(mine[1])
  return (
    <div className="cover-pop">
      <div className="cover-grid">
        {PICKER.map((g) => (
          <button key={g.id} title={t(g.label)} aria-label={t(g.label)} className={curId === g.id ? 'on' : ''} style={{ background: g.css }} onClick={() => (onPick({ kind: 'gradient', id: g.id }), onClose())} />
        ))}
      </div>
      <div className="cover-custom">
        <span>{t('Your own colors')}</span>
        <input type="color" value={a} aria-label={t('First color')} onChange={(e) => setA(e.target.value)} />
        <input type="color" value={b} aria-label={t('Second color')} onChange={(e) => setB(e.target.value)} />
        <i style={{ background: soft(a, b) }} />
        <button type="button" onClick={() => (onPick({ kind: 'gradient', id: `custom:${a},${b}` }), onClose())}>{t('Use')}</button>
      </div>
      <button
        className="cover-row"
        onClick={async () => {
          const [f] = await pickFiles('image/*')
          if (!f) return
          onPick({ kind: 'image', file: await putFile(f) })
          onClose()
        }}
      >
        <Ic.Upload size={15} />{t('Upload image…')}
      </button>
      {cur && (
        <button className="cover-row danger" onClick={() => (onPick(undefined), onClose())}>
          <Ic.Trash size={15} />{t('Remove cover')}
        </button>
      )}
    </div>
  )
}
