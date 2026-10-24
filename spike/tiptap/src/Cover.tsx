import { useEffect, useState } from 'react'
import type { Cover, Page } from './repo'
import { pickFiles } from './io'
import { putFile, urlFor } from './attachments'
import * as Ic from './icons'
import { t } from './i18n'

/** Built-in covers: pure CSS, so they cost no storage and survive backup/restore untouched. */
// A layered silhouette (SVG polygons, bottom-anchored) over a sky gradient: the Notion-style scenic covers, with no image files.
const ridge = (fill: string, d: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 400' preserveAspectRatio='none'%3E%3Cpath fill='${encodeURIComponent(fill)}' d='${d}'/%3E%3C/svg%3E") bottom / 100% 70% no-repeat`
const scene = (sky: string, ...layers: [string, string][]) => [...layers.map(([f, d]) => ridge(f, d)).reverse(), sky].join(', ')
const PEAKS_A = 'M0 400V250l90-70 70 40 110-120 100 110 80-60 120 140 90-90 110 100 90-70 120 120 90-60 120 110V400z'
const PEAKS_B = 'M0 400V300l120-60 90 50 130-90 110 80 100-40 140 90 110-70 130 60 100-50 160 100V400z'
const PEAKS_C = 'M0 400V340l140-40 120 30 160-60 140 50 160-30 130 40 150-30 200 40V400z'
const DUNES = 'M0 400V300c150-80 300-80 450 0s300 80 450 0 200-40 300 0V400z'
const WAVE = 'M0 400V280c100-50 200-50 300 0s200 50 300 0 200-50 300 0 200 50 300 0V400z'
const PINES = 'M0 400V280l30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100 30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100 30-80 30 80 30-60 30 60 30-90 30 90 30-70 30 70 30-100 30 100 30-60 30 60 30-80 30 80 30-70 30 70 30-90 30 90 30-60 30 60 30-100 30 100V400z'
const mesh = (...stops: [string, number, number][]) => stops.map(([c, x, y]) => `radial-gradient(at ${x}% ${y}%, ${c} 0, transparent 55%)`).join(', ')

const GRADIENTS: { id: string; label: string; css: string }[] = [
  { id: 'aurora', label: 'Aurora', css: 'linear-gradient(120deg, #6a5cf5 0%, #8f6bf7 45%, #4aa3ff 100%)' },
  { id: 'sunset', label: 'Sunset', css: 'linear-gradient(120deg, #ff7a59 0%, #ff5f8a 50%, #a45cf0 100%)' },
  { id: 'ocean', label: 'Ocean', css: 'linear-gradient(120deg, #1f6fe5 0%, #1aa7c9 55%, #35d0b0 100%)' },
  { id: 'forest', label: 'Forest', css: 'linear-gradient(120deg, #11634a 0%, #1f9a6a 55%, #8fd16b 100%)' },
  { id: 'rose', label: 'Rose', css: 'linear-gradient(120deg, #e24a9f 0%, #f27aa8 50%, #ffb48a 100%)' },
  { id: 'dusk', label: 'Dusk', css: 'linear-gradient(120deg, #2b2f6b 0%, #5a3f8f 50%, #c06a9f 100%)' },
  { id: 'mist', label: 'Mist', css: 'linear-gradient(120deg, #cfd6ea 0%, #e3e0f3 50%, #f1e4ef 100%)' },
  { id: 'ink', label: 'Ink', css: 'linear-gradient(120deg, #0d0e14 0%, #1a1c2a 55%, #2a2d44 100%)' },
  { id: 'alpenglow', label: 'Alpenglow', css: scene('linear-gradient(180deg, #5d6fb8 0%, #b987b5 40%, #ffb38a 75%, #ffd9a8 100%)', ['#3b3f6e', PEAKS_A], ['#262a52', PEAKS_B], ['#15183a', PEAKS_C]) },
  { id: 'highland', label: 'Highland', css: scene('linear-gradient(180deg, #8fb6e8 0%, #cfe0f2 55%, #f6ead9 100%)', ['#9aa9c9', PEAKS_A], ['#6d7fa8', PEAKS_B], ['#41507a', PEAKS_C]) },
  { id: 'nightsky', label: 'Night sky', css: scene('radial-gradient(circle at 78% 22%, #fff7d6 0 2.5%, transparent 3%), linear-gradient(180deg, #0b1030 0%, #1d2461 55%, #4a4f9a 100%)', ['#10143a', PEAKS_B], ['#080b24', PEAKS_C]) },
  { id: 'dunes', label: 'Dunes', css: scene('linear-gradient(180deg, #f6c58b 0%, #f0a36b 50%, #e87a5d 100%)', ['#c9764f', DUNES], ['#a85a3e', WAVE]) },
  { id: 'tide', label: 'Tide', css: scene('linear-gradient(180deg, #9fe0e8 0%, #5cbcd8 55%, #2f86c4 100%)', ['#2c79b8', WAVE], ['#1b5a99', DUNES]) },
  { id: 'pinewood', label: 'Pinewood', css: scene('linear-gradient(180deg, #cde9d6 0%, #8fcaa6 60%, #4f9d7b 100%)', ['#2f7a5c', PINES], ['#1c5640', PEAKS_C]) },
  { id: 'mesh-iris', label: 'Iris', css: mesh(['#ffb8e0', 12, 18], ['#8fb4ff', 85, 12], ['#b79bff', 55, 90], ['#9fe6ff', 10, 88]) + ', #e9e4ff' },
  { id: 'mesh-peach', label: 'Peach', css: mesh(['#ffd1a6', 15, 20], ['#ff9fb0', 88, 25], ['#ffe9a8', 50, 95], ['#ffb0d0', 8, 85]) + ', #fff1e6' },
  { id: 'mesh-mint', label: 'Mint', css: mesh(['#b5f0d5', 12, 22], ['#a6d8ff', 88, 18], ['#d9f7b0', 50, 92], ['#9ae6e0', 90, 80]) + ', #e8fbf2' },
  { id: 'mesh-ember', label: 'Ember', css: mesh(['#ff6a5c', 10, 15], ['#ffb347', 82, 20], ['#c4326f', 60, 92], ['#6a2bb5', 6, 90]) + ', #4a1c63' },
  { id: 'mesh-deep', label: 'Deep sea', css: mesh(['#2fd0c6', 10, 20], ['#2f6bff', 85, 15], ['#7a3bff', 55, 95], ['#00a6d6', 8, 85]) + ', #0b1f4d' },
  { id: 'sand', label: 'Sand', css: 'linear-gradient(120deg, #efe4d2 0%, #f6efe3 50%, #e7dcc8 100%)' },
]

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
  if (cover.kind === 'gradient') return { background: GRADIENTS.find((g) => g.id === cover.id)?.css ?? GRADIENTS[0].css }
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
  return (
    <div className="cover-pop">
      <div className="cover-grid">
        {GRADIENTS.map((g) => (
          <button
            key={g.id}
            title={t(g.label)}
            className={cur?.kind === 'gradient' && cur.id === g.id ? 'on' : ''}
            style={{ background: g.css }}
            onClick={() => (onPick({ kind: 'gradient', id: g.id }), onClose())}
          />
        ))}
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
