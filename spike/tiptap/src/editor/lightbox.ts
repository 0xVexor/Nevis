import { t } from '../i18n'

interface LightboxSource {
  svg?: string // markup of a diagram
  src?: string // image address (object URL or http)
  alt?: string
}

const PAD = 28 // white "paper" around diagrams, so they stay readable on the dark backdrop

/**
 * Full-window viewer for a diagram or an image.
 * Wheel = zoom at the pointer, drag = move, double-click = fit / 100 %, + − 0 1 = zoom keys, Esc or click outside = close.
 */
export function openLightbox(source: LightboxSource): () => void {
  const opener = document.activeElement as HTMLElement | null
  const root = document.createElement('div')
  root.className = 'lightbox'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', source.alt || t('Enlarged view'))

  const stage = document.createElement('div')
  stage.className = 'lb-stage'
  const content = document.createElement('div')
  content.className = 'lb-content' + (source.svg ? ' paper' : '')
  stage.append(content)

  const bar = document.createElement('div')
  bar.className = 'lb-bar'
  const mk = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.onclick = (e) => (e.stopPropagation(), fn())
    return b
  }
  const pct = document.createElement('span')
  pct.className = 'lb-pct'
  bar.append(
    mk('−', t('Zoom out') + '  −', () => zoomBy(1 / 1.25)),
    pct,
    mk('+', t('Zoom in') + '  +', () => zoomBy(1.25)),
    mk(t('Fit'), t('Fit to window') + '  0', () => fit()),
    mk('100%', t('Actual size') + '  1', () => actual()),
    mk('✕', t('Close') + '  Esc', () => close()),
  )
  root.append(stage, bar)
  document.body.append(root)

  let w = 1
  let h = 1
  let scale = 1
  let tx = 0
  let ty = 0
  let touched = false // the user zoomed or panned: stop auto-fitting
  const rect = () => stage.getBoundingClientRect()
  const apply = () => {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    pct.textContent = `${Math.round(scale * 100)}%`
  }
  const center = () => {
    const r = rect()
    tx = (r.width - w * scale) / 2
    ty = (r.height - h * scale) / 2
  }
  const fit = () => {
    const r = rect()
    scale = Math.min(Math.max(Math.min((r.width * 0.92) / w, (r.height * 0.86) / h), 0.05), 4)
    center()
    apply()
  }
  const actual = () => {
    touched = true
    scale = 1
    center()
    apply()
  }
  const zoomAt = (factor: number, px: number, py: number) => {
    touched = true
    const next = Math.min(Math.max(scale * factor, 0.05), 16)
    const k = next / scale
    tx = px - (px - tx) * k // keep the point under the pointer where it is
    ty = py - (py - ty) * k
    scale = next
    apply()
  }
  const zoomBy = (factor: number) => {
    const r = rect()
    zoomAt(factor, r.width / 2, r.height / 2)
  }

  const size = (cw: number, ch: number) => {
    w = cw
    h = ch
    content.style.width = `${w}px`
    content.style.height = `${h}px`
    fit()
  }

  if (source.svg) {
    content.innerHTML = source.svg
    const svg = content.querySelector('svg')
    if (svg) {
      const vb = svg.viewBox?.baseVal
      const sw = vb && vb.width ? vb.width : svg.getBoundingClientRect().width || 600
      const sh = vb && vb.height ? vb.height : svg.getBoundingClientRect().height || 400
      svg.removeAttribute('style') // mermaid sets max-width inline
      svg.setAttribute('width', String(sw))
      svg.setAttribute('height', String(sh))
      size(sw + PAD * 2, sh + PAD * 2)
    }
  } else if (source.src) {
    const img = new Image()
    img.alt = source.alt ?? ''
    img.draggable = false
    img.onload = () => size(img.naturalWidth || 800, img.naturalHeight || 600)
    img.src = source.src
    content.append(img)
  }

  // ── interaction ──
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false }
    stage.setPointerCapture(e.pointerId)
    stage.classList.add('grabbing')
  })
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) (drag.moved = true), (touched = true)
    tx = drag.tx + dx
    ty = drag.ty + dy
    apply()
  })
  stage.addEventListener('pointerup', (e) => {
    const moved = drag?.moved
    drag = null
    stage.classList.remove('grabbing')
    if (!moved && !content.contains(e.target as Node)) close() // a plain click on the empty backdrop
  })
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = rect()
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
    },
    { passive: false },
  )
  stage.addEventListener('dblclick', () => (Math.abs(scale - 1) < 0.01 ? fit() : actual()))

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close())
    else if (e.key === '+' || e.key === '=') zoomBy(1.25)
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.25)
    else if (e.key === '0') fit()
    else if (e.key === '1') actual()
    else return
    e.stopPropagation()
  }
  // Re-fit whenever the stage gets (or changes) its size — also when it was still 0 at the first call —
  // until the user zooms or pans by hand.
  const ro = new ResizeObserver(() => {
    if (!touched && rect().width > 0) fit()
  })
  ro.observe(stage)
  document.addEventListener('keydown', onKey, true) // capture: the editor must not see these keys meanwhile

  function close() {
    document.removeEventListener('keydown', onKey, true)
    ro.disconnect()
    root.remove()
    opener?.focus?.()
  }
  fit()
  return close
}
