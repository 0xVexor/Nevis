// Appearance settings. Everything is applied as CSS variables on <html> (see docs/design-language.md),
// so no component needs to know about them. Persisted in localStorage (small, per device).
import { useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
export type SidebarStyle = 'default' | 'compact' | 'icons'
export type Lang = 'en' | 'fa'
type LayoutDir = 'auto' | 'ltr' | 'rtl' // auto = follow the language
export type FontId = 'vazir' | 'ibm' | 'naskh' | 'system' | 'serif' | 'mono'
export type Background = { kind: 'default' } | { kind: 'none' } | { kind: 'preset'; id: string } | { kind: 'image'; file: string }

export interface Settings {
  lang: Lang // UI language; English by default
  dir: LayoutDir // layout direction of the whole UI (sidebar side, lists, panels)
  theme: Theme
  accent: string | null // null = the theme's own default
  bg: Background
  radius: number // px of --radius; the small/large steps derive from it
  font: FontId
  fontSize: number // editor text, px
  textColor: string | null // editor text colour, null = theme text colour
  sidebar: SidebarStyle
  glass: boolean // floating, blurred sidebar card instead of a flat one
  showCovers: boolean
  showIcons: boolean
  cardReminders: boolean
  compressImages: boolean
  reduceMotion: boolean
}

export const DEFAULTS: Settings = { lang: 'en', dir: 'auto', theme: 'light', accent: null, bg: { kind: 'default' }, radius: 12, font: 'vazir', fontSize: 16, textColor: null, sidebar: 'default', glass: false, showCovers: true, showIcons: true, reduceMotion: false, cardReminders: true, compressImages: true }

const KEY = 'not.settings'
const LEGACY_THEME = 'not.theme' // 'light' | 'dark' | null from before the settings page

export const ACCENTS = ['#6857f0', '#3b6cf6', '#0ea5c6', '#22b07d', '#f59e0b', '#ef5b4f', '#e24a9f', '#8b8fa3']
export const TEXT_COLORS = ['#6857f0', '#3b6cf6', '#0e8fa8', '#1e9d6b', '#c27c0a', '#d6453a', '#c23a85', '#7a7f96']

export const FONTS: { id: FontId; label: string; stack: string; css?: () => Promise<unknown> }[] = [
  { id: 'vazir', label: 'Vazirmatn (default)', stack: "'Vazirmatn', 'Segoe UI', Tahoma, system-ui, sans-serif" },
  {
    id: 'ibm',
    label: 'IBM Plex Sans Arabic',
    stack: "'IBM Plex Sans Arabic', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif",
    css: () => Promise.all([import('@fontsource/ibm-plex-sans-arabic/400.css'), import('@fontsource/ibm-plex-sans-arabic/500.css'), import('@fontsource/ibm-plex-sans-arabic/700.css')]),
  },
  {
    id: 'naskh',
    label: 'Noto Naskh',
    stack: "'Noto Naskh Arabic', 'Vazirmatn', 'Times New Roman', serif",
    css: () => Promise.all([import('@fontsource/noto-naskh-arabic/400.css'), import('@fontsource/noto-naskh-arabic/500.css'), import('@fontsource/noto-naskh-arabic/700.css')]),
  },
  { id: 'system', label: 'System font', stack: "system-ui, 'Segoe UI', Tahoma, sans-serif" },
  { id: 'serif', label: 'Serif (Georgia)', stack: "Georgia, 'Times New Roman', 'Vazirmatn', serif" },
  { id: 'mono', label: 'Monospace', stack: "'Cascadia Mono', Consolas, 'Vazirmatn', monospace" },
]

/** Backgrounds behind the floating panels; each is a pair of glows, [light-mode, dark-mode] colours. */
export const PRESETS: { id: string; label: string; light: [string, string]; dark: [string, string] }[] = [
  { id: 'nebula', label: 'Nebula', light: ['rgba(140,110,255,.36)', 'rgba(255,110,200,.28)'], dark: ['rgba(110,70,255,.34)', 'rgba(230,50,170,.22)'] },
  { id: 'lagoon', label: 'Lagoon', light: ['rgba(40,200,220,.34)', 'rgba(70,130,255,.28)'], dark: ['rgba(10,170,200,.28)', 'rgba(30,80,230,.26)'] },
  { id: 'peach', label: 'Peach fizz', light: ['rgba(255,140,110,.36)', 'rgba(255,205,120,.32)'], dark: ['rgba(240,90,70,.28)', 'rgba(250,160,50,.2)'] },
  { id: 'matcha', label: 'Matcha', light: ['rgba(120,210,120,.34)', 'rgba(220,235,110,.3)'], dark: ['rgba(40,170,90,.26)', 'rgba(150,180,30,.18)'] },
  { id: 'orchid', label: 'Orchid', light: ['rgba(200,110,255,.34)', 'rgba(255,150,210,.3)'], dark: ['rgba(170,60,240,.3)', 'rgba(240,80,160,.22)'] },
  { id: 'arctic', label: 'Arctic', light: ['rgba(150,215,255,.4)', 'rgba(190,200,255,.32)'], dark: ['rgba(60,150,230,.26)', 'rgba(100,110,230,.22)'] },
  { id: 'ember', label: 'Ember', light: ['rgba(255,110,80,.34)', 'rgba(255,60,130,.26)'], dark: ['rgba(255,70,40,.3)', 'rgba(200,30,100,.24)'] },
  { id: 'dusk', label: 'Dusk', light: ['rgba(110,100,230,.34)', 'rgba(255,160,120,.3)'], dark: ['rgba(80,60,220,.32)', 'rgba(240,110,80,.2)'] },
  { id: 'sakura', label: 'Sakura', light: ['rgba(255,170,200,.4)', 'rgba(255,220,230,.34)'], dark: ['rgba(230,90,150,.24)', 'rgba(180,70,120,.2)'] },
  { id: 'cyber', label: 'Cyber', light: ['rgba(0,230,200,.3)', 'rgba(150,80,255,.3)'], dark: ['rgba(0,220,190,.22)', 'rgba(140,50,255,.3)'] },
  { id: 'gold', label: 'Golden hour', light: ['rgba(255,200,80,.4)', 'rgba(255,130,90,.3)'], dark: ['rgba(240,170,30,.24)', 'rgba(230,90,50,.22)'] },
  { id: 'midnight', label: 'Midnight', light: ['rgba(70,80,180,.3)', 'rgba(40,120,200,.26)'], dark: ['rgba(40,50,160,.38)', 'rgba(20,90,170,.3)'] },
]

const glow = ([a, b]: [string, string]) => `radial-gradient(900px 560px at 0% 0%, ${a}, transparent 62%), radial-gradient(800px 560px at 100% 100%, ${b}, transparent 62%), radial-gradient(700px 520px at 85% 0%, color-mix(in srgb, ${a} 50%, ${b}), transparent 65%)`

function load(): Settings {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}
    if (!localStorage.getItem(KEY)) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_THEME) ?? 'null')
      if (legacy === 'light' || legacy === 'dark') saved.theme = legacy
    }
  } catch {
    /* corrupt value: fall back to defaults */
  }
  return { ...DEFAULTS, ...saved }
}

let state: Settings = load()
const subs = new Set<() => void>()

export const getSettings = () => state
const subscribe = (fn: () => void) => (subs.add(fn), () => void subs.delete(fn))

export function updateSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* private mode: the change still applies for this session */
  }
  apply()
  subs.forEach((f) => f())
}

export const useSettings = () => useSyncExternalStore(subscribe, getSettings)

/** Is the dark palette showing right now? */
export const isDark = (s: Settings = state) => (s.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : s.theme === 'dark')

const onAccent = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.62 ? '#14151c' : '#ffffff'
}

let bgToken = 0
async function applyBackground(root: HTMLElement, bg: Background) {
  const set = (light: string | null, dark: string | null) => {
    for (const [k, v] of [['--bg-custom-light', light], ['--bg-custom-dark', dark]] as const) v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v)
  }
  const token = ++bgToken
  if (bg.kind === 'default') return set(null, null)
  if (bg.kind === 'none') return set('none', 'none')
  if (bg.kind === 'preset') {
    const p = PRESETS.find((x) => x.id === bg.id)
    return p ? set(glow(p.light), glow(p.dark)) : set(null, null)
  }
  const { urlFor } = await import('./attachments')
  const url = await urlFor('att:' + bg.file)
  if (token !== bgToken) return // a newer choice won while the file was loading
  if (!url) return set(null, null)
  set(`linear-gradient(rgba(255,255,255,.55), rgba(255,255,255,.55)), url("${url}")`, `linear-gradient(rgba(6,7,12,.62), rgba(6,7,12,.62)), url("${url}")`)
}

const ARROW = 'M4 2.5V18.5L8.2 14.6L11 20.6L13.6 19.4L10.9 13.6L16.8 13.4Z'
const HAND = 'M9 4Q9 2 10.5 2Q12 2 12 4V8.6Q12.7 8 13.5 8Q15 8 15 9.6Q15.7 9 16.5 9Q18 9 18 10.6Q18.7 10 19.5 10Q21 10 21 11.6V16Q21 21 15.5 21.5H13Q10 21.5 8 19L4.4 14.6Q3.6 13.4 4.8 12.6Q6 12 7 13L9 15Z'
const wrapSvg = (inner: string) => 'url("data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24">${inner}</svg>`) + '")'
// filled shape: dark halo, white edge, accent fill
const shape = (d: string, fill: string) => wrapSvg(`<path d="${d}" fill="${fill}" stroke="rgba(14,10,40,0.5)" stroke-width="3.6" stroke-linejoin="round"/><path d="${d}" fill="${fill}" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>`)
// line drawing (arrows, magnifier handle): dark halo, white body, accent core
const lines = (d: string, accent: string) => wrapSvg(`<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="rgba(14,10,40,0.5)" stroke-width="5.6"/><path d="${d}" stroke="#fff" stroke-width="4"/><path d="${d}" stroke="${accent}" stroke-width="1.9"/></g>`)
const GRAB = 'M7 9.5V5.5Q7 4 8.5 4Q10 4 10 5.5V8.5V4.5Q10 3 11.5 3Q13 3 13 4.5V8.5V5Q13 3.5 14.5 3.5Q16 3.5 16 5V9V7.5Q16 6 17.5 6Q19 6 19 7.5V14Q19 20 13 20H11.5Q8.5 20 6.5 17.5L3.8 13.5Q3.2 12.4 4.3 11.8Q5.4 11.3 6.2 12.2L7 13Z'
const GRABBING = 'M5 12Q5 9 7 9Q7.6 7.5 9 7.5Q10 7.5 10.5 8.3Q11.3 7 12.5 7Q13.7 7 14.3 8.3Q15.1 7.6 16 7.6Q17.7 7.6 18 9.2Q20 9.4 20 12V15.5Q20 20 14.5 20H10.5Q5 20 5 15.5Z'
// magnifier with a plus: handle drawn as a line (halo, white, accent), lens as a filled circle
const zoomCursor = (hex: string) =>
  wrapSvg(
    '<path d="M15.5 15.5L21 21" fill="none" stroke="rgba(14,10,40,0.5)" stroke-width="5.6" stroke-linecap="round"/>' +
      '<path d="M15.5 15.5L21 21" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>' +
      `<path d="M15.5 15.5L21 21" fill="none" stroke="${hex}" stroke-width="1.9" stroke-linecap="round"/>` +
      `<circle cx="10" cy="10" r="6.5" fill="${hex}" stroke="rgba(14,10,40,0.5)" stroke-width="3.6"/>` +
      `<circle cx="10" cy="10" r="6.5" fill="${hex}" stroke="#fff" stroke-width="1.7"/>` +
      '<path d="M10 7v6M7 10h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  )
const cursors = (hex: string) => ({
  arrow: `${shape(ARROW, hex)} 4 3, default`,
  hand: `${shape(HAND, hex)} 11 3, pointer`,
  grab: `${shape(GRAB, hex)} 12 11, grab`,
  grabbing: `${shape(GRABBING, hex)} 12 12, grabbing`,
  zoom: `${zoomCursor(hex)} 10 10, zoom-in`,
  nwse: `${lines('M6 6h5M6 6v5M6 6L18 18M18 18h-5M18 18v-5', hex)} 12 12, nwse-resize`,
  nesw: `${lines('M18 6h-5M18 6v5M18 6L6 18M6 18h5M6 18v-5', hex)} 12 12, nesw-resize`,
})

const loadedFonts = new Set<FontId>()

export function apply(s: Settings = state) {
  const root = document.documentElement
  s.theme === 'system' ? delete root.dataset.theme : (root.dataset.theme = s.theme)
  root.lang = s.lang
  root.dir = s.dir === 'auto' ? (s.lang === 'fa' ? 'rtl' : 'ltr') : s.dir

  const set = (k: string, v: string | null) => (v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v))
  set('--accent', s.accent)
  set('--accent-on', s.accent ? onAccent(s.accent) : null)
  // a chosen accent keeps its own hue in gradients (the stock accent drifts toward pink)
  set('--accent-2', s.accent ? 'oklch(from var(--accent) calc(l + 0.06) c calc(h + 16))' : null)
  // the mouse pointer is drawn in the accent colour, with a white edge and a dark halo so it reads on light and dark surfaces alike
  const cur = cursors(s.accent ?? (isDark(s) ? '#8479ff' : '#6a5cff'))
  set('--cursor-arrow', cur.arrow)
  set('--cursor-hand', cur.hand)
  set('--cursor-grab', cur.grab)
  set('--cursor-grabbing', cur.grabbing)
  set('--cursor-zoom', cur.zoom)
  set('--cursor-nwse', cur.nwse)
  set('--cursor-nesw', cur.nesw)
  set('--radius', s.radius === DEFAULTS.radius ? null : s.radius + 'px')
  set('--radius-sm', s.radius === DEFAULTS.radius ? null : Math.max(3, Math.round(s.radius * 0.67)) + 'px')
  set('--radius-lg', s.radius === DEFAULTS.radius ? null : Math.round(s.radius * 1.33) + 'px')
  set('--editor-size', s.fontSize === DEFAULTS.fontSize ? null : s.fontSize + 'px')
  set('--editor-color', s.textColor)
  // boolean/enum switches are plain attributes on <html>; the stylesheet decides what they mean
  const flag = (k: string, on: boolean, v = '1') => (on ? root.setAttribute(k, v) : root.removeAttribute(k))
  flag('data-side', s.sidebar !== 'default', s.sidebar)
  flag('data-glass', s.glass)
  flag('data-covers', !s.showCovers, 'off')
  flag('data-icons', !s.showIcons, 'off')
  flag('data-motion', s.reduceMotion, 'reduce')

  const f = FONTS.find((x) => x.id === s.font) ?? FONTS[0]
  set('--font', f.id === 'vazir' ? null : f.stack)
  if (f.css && !loadedFonts.has(f.id)) (loadedFonts.add(f.id), void f.css().catch(() => loadedFonts.delete(f.id)))

  void applyBackground(root, s.bg)
}

apply()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (apply(), subs.forEach((f) => f())))
