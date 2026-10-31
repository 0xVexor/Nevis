import { setPreference } from './preferenceEvents'
// Appearance settings. Everything is applied as CSS variables on <html> (see docs/design-language.md),
// so no component needs to know about them. Persisted in localStorage (small, per device).
import { useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
export type SidebarStyle = 'default' | 'compact' | 'icons'
export type PagesView = 'tree' | 'compact' // compact: every folder / page with subpages is one flat row (its full path), its files listed right under it
export type Lang = 'en' | 'fa'
type LayoutDir = 'auto' | 'ltr' | 'rtl' // auto = follow the language
export type FontId = 'vazir' | 'estedad' | 'notosans' | 'ibm' | 'kufi' | 'naskh' | 'amiri' | 'inter' | 'geist' | 'jakarta' | 'sourceserif' | 'jetbrains' | 'system' | 'serif' | 'mono'
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
  pagesView: PagesView
  sideGlass: number // 0-100: how see-through (and blurred) the sidebar is
  mainGlass: number // 0-100: the same for the main panel
  bgStrength: number // 50-200 (%): how strongly the background colours glow
  showCovers: boolean
  showIcons: boolean
  cardReminders: boolean
  compressImages: boolean
  reduceMotion: boolean
  prereleaseUpdates: boolean
}

export const DEFAULTS: Settings = { lang: 'en', dir: 'auto', theme: 'light', accent: null, bg: { kind: 'default' }, radius: 12, font: 'vazir', fontSize: 16, textColor: null, sidebar: 'default', pagesView: 'tree', sideGlass: 0, mainGlass: 0, bgStrength: 100, showCovers: true, showIcons: true, reduceMotion: false, cardReminders: true, compressImages: true, prereleaseUpdates: false }

const KEY = 'not.settings'
const LEGACY_THEME = 'not.theme' // 'light' | 'dark' | null from before the settings page

export const ACCENTS = ['#6857f0', '#3b6cf6', '#0ea5c6', '#22b07d', '#f59e0b', '#ef5b4f', '#e24a9f', '#8b8fa3']
export const TEXT_COLORS = ['#6857f0', '#3b6cf6', '#0e8fa8', '#1e9d6b', '#c27c0a', '#d6453a', '#c23a85', '#7a7f96']

export type FontGroup = 'persian' | 'english' | 'system'
export interface FontDef {
  id: FontId
  label: string
  group: FontGroup
  stack: string
  sample?: string // what the picker shows in this face (defaults to the group's sample)
  css?: () => Promise<unknown>
}

const FA_TAIL = "'Vazirmatn', 'Segoe UI', Tahoma, sans-serif" // Persian letters fall back to Vazirmatn in the Latin faces
const w3 = (a: () => Promise<unknown>, b: () => Promise<unknown>, c: () => Promise<unknown>) => () => Promise.all([a(), b(), c()])

/** Faces for page text, grouped for the picker. Every web font is bundled (@fontsource) and loaded only when chosen or previewed. */
export const FONTS: FontDef[] = [
  { id: 'vazir', group: 'persian', label: 'Vazirmatn (default)', stack: "'Vazirmatn', 'Segoe UI', Tahoma, system-ui, sans-serif" },
  { id: 'estedad', group: 'persian', label: 'Estedad', stack: "'Estedad', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif", css: w3(() => import('@fontsource/estedad/400.css'), () => import('@fontsource/estedad/500.css'), () => import('@fontsource/estedad/700.css')) },
  { id: 'notosans', group: 'persian', label: 'Noto Sans Arabic', stack: "'Noto Sans Arabic', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif", css: w3(() => import('@fontsource/noto-sans-arabic/400.css'), () => import('@fontsource/noto-sans-arabic/500.css'), () => import('@fontsource/noto-sans-arabic/700.css')) },
  { id: 'ibm', group: 'persian', label: 'IBM Plex Sans Arabic', stack: "'IBM Plex Sans Arabic', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif", css: w3(() => import('@fontsource/ibm-plex-sans-arabic/400.css'), () => import('@fontsource/ibm-plex-sans-arabic/500.css'), () => import('@fontsource/ibm-plex-sans-arabic/700.css')) },
  { id: 'kufi', group: 'persian', label: 'Noto Kufi Arabic', stack: "'Noto Kufi Arabic', 'Vazirmatn', 'Segoe UI', Tahoma, sans-serif", css: w3(() => import('@fontsource/noto-kufi-arabic/400.css'), () => import('@fontsource/noto-kufi-arabic/500.css'), () => import('@fontsource/noto-kufi-arabic/700.css')) },
  { id: 'naskh', group: 'persian', label: 'Noto Naskh', stack: "'Noto Naskh Arabic', 'Vazirmatn', 'Times New Roman', serif", css: w3(() => import('@fontsource/noto-naskh-arabic/400.css'), () => import('@fontsource/noto-naskh-arabic/500.css'), () => import('@fontsource/noto-naskh-arabic/700.css')) },
  { id: 'amiri', group: 'persian', label: 'Amiri', stack: "'Amiri', 'Vazirmatn', 'Times New Roman', serif", css: () => Promise.all([import('@fontsource/amiri/400.css'), import('@fontsource/amiri/700.css')]) },

  { id: 'inter', group: 'english', label: 'Inter', stack: `'Inter', ${FA_TAIL}`, css: w3(() => import('@fontsource/inter/400.css'), () => import('@fontsource/inter/500.css'), () => import('@fontsource/inter/700.css')) },
  { id: 'geist', group: 'english', label: 'Geist', stack: `'Geist', ${FA_TAIL}`, css: w3(() => import('@fontsource/geist-sans/400.css'), () => import('@fontsource/geist-sans/500.css'), () => import('@fontsource/geist-sans/700.css')) },
  { id: 'jakarta', group: 'english', label: 'Plus Jakarta Sans', stack: `'Plus Jakarta Sans', ${FA_TAIL}`, css: w3(() => import('@fontsource/plus-jakarta-sans/400.css'), () => import('@fontsource/plus-jakarta-sans/500.css'), () => import('@fontsource/plus-jakarta-sans/700.css')) },
  { id: 'sourceserif', group: 'english', label: 'Source Serif', stack: "'Source Serif 4', 'Vazirmatn', Georgia, serif", css: w3(() => import('@fontsource/source-serif-4/400.css'), () => import('@fontsource/source-serif-4/500.css'), () => import('@fontsource/source-serif-4/700.css')) },
  { id: 'jetbrains', group: 'english', label: 'JetBrains Mono', stack: "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Vazirmatn', monospace", css: w3(() => import('@fontsource/jetbrains-mono/400.css'), () => import('@fontsource/jetbrains-mono/500.css'), () => import('@fontsource/jetbrains-mono/700.css')) },

  { id: 'system', group: 'system', label: 'System font', stack: "system-ui, 'Segoe UI', Tahoma, sans-serif" },
  { id: 'serif', group: 'system', label: 'Serif (Georgia)', stack: "Georgia, 'Times New Roman', 'Vazirmatn', serif" },
  { id: 'mono', group: 'system', label: 'Monospace', stack: "'Cascadia Mono', Consolas, 'Vazirmatn', monospace" },
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

/** Scales the alpha of an rgba() colour (the presets are all written that way). */
const alpha = (c: string, k: number) => c.replace(/rgba((d+),(d+),(d+),([d.]+))/, (_, r, g, b, a) => `rgba(${r},${g},${b},${Math.min(0.9, +a * k).toFixed(3)})`)
const BASE_GLOW = 1.45 // the stock presets were too faint behind opaque panels
const glow = ([a0, b0]: [string, string], strength: number) => {
  const k = BASE_GLOW * (strength / 100)
  const [a, b] = [alpha(a0, k), alpha(b0, k)]
  return `radial-gradient(1500px 1000px at 0% 0%, ${a}, transparent 68%), radial-gradient(1400px 1000px at 100% 100%, ${b}, transparent 68%), radial-gradient(1100px 800px at 85% 0%, color-mix(in srgb, ${a} 50%, ${b}), transparent 70%)`
}

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
  const old = saved as { glass?: boolean }
  if (old.glass && saved.sideGlass === undefined) saved.sideGlass = 60 // the old on/off switch became a slider
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([key]) => key in DEFAULTS)) }
}

let state: Settings = load()
const subs = new Set<() => void>()

export const getSettings = () => state
const subscribe = (fn: () => void) => (subs.add(fn), () => void subs.delete(fn))

export function updateSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch }
  try {
    setPreference(KEY, JSON.stringify(state))
  } catch {
    /* private mode: the change still applies for this session */
  }
  apply()
  subs.forEach((f) => f())
}

export function reloadSettings() {
  state = load()
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
async function applyBackground(root: HTMLElement, bg: Background, strength: number) {
  const set = (light: string | null, dark: string | null) => {
    for (const [k, v] of [['--bg-custom-light', light], ['--bg-custom-dark', dark]] as const) v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v)
  }
  const token = ++bgToken
  if (bg.kind === 'default') return set(null, null)
  if (bg.kind === 'none') return set('none', 'none')
  if (bg.kind === 'preset') {
    const p = PRESETS.find((x) => x.id === bg.id)
    return p ? set(glow(p.light, strength), glow(p.dark, strength)) : set(null, null)
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
// the same hue, shifted in lightness (OKLab): the pointer stays recognisably the accent but never melts into accent-coloured buttons
const toneOf = (hex: string, dL: number) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const sv = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = Math.min(0.95, Math.max(0.2, 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sv + dL))
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sv
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sv
  const l3 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m3 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s3 = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, gam(v))) * 255).toString(16).padStart(2, '0')
  return '#' + ch(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3) + ch(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3) + ch(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3)
}
const cursors = (hex: string) => ({
  arrow: `${shape(ARROW, hex)} 4 3, default`,
  hand: `${shape(HAND, hex)} 11 3, pointer`,
  text: `${lines('M9 4h6M12 4v16M9 20h6', hex)} 12 12, text`,
  grab: `${shape(GRAB, hex)} 12 11, grab`,
  grabbing: `${shape(GRABBING, hex)} 12 12, grabbing`,
  zoom: `${zoomCursor(hex)} 10 10, zoom-in`,
  nwse: `${lines('M6 6h5M6 6v5M6 6L18 18M18 18h-5M18 18v-5', hex)} 12 12, nwse-resize`,
  ew: `${lines('M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4', hex)} 12 12, col-resize`,
  nesw: `${lines('M18 6h-5M18 6v5M18 6L6 18M6 18h5M6 18v-5', hex)} 12 12, nesw-resize`,
})

const loadedFonts = new Set<FontId>()
/** Pulls in a bundled face's CSS once (also used by the font picker to preview each face in itself). */
export function loadFont(f: FontDef) {
  if (f.css && !loadedFonts.has(f.id)) (loadedFonts.add(f.id), void f.css().catch(() => loadedFonts.delete(f.id)))
}

export function apply(s: Settings = state) {
  const root = document.documentElement
  s.theme === 'system' ? delete root.dataset.theme : (root.dataset.theme = s.theme)
  root.lang = s.lang
  root.dir = s.dir === 'auto' ? (s.lang === 'fa' ? 'rtl' : 'ltr') : s.dir

  const set = (k: string, v: string | null) => (v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v))
  set('--accent', s.accent)
  set('--accent-on', s.accent ? onAccent(s.accent) : null)
  // the design system (src/design-system) derives every colour from this one value; null falls back to its own default
  set('--user-accent', s.accent)
  set('--ds-accent-ink', s.accent ? onAccent(s.accent) : null)
  // a chosen accent keeps its own hue in gradients (the stock accent drifts toward pink)
  set('--accent-2', s.accent ? 'oklch(from var(--accent) calc(l + 0.06) c calc(h + 16))' : null)
  // the mouse pointer is drawn in a shade of the accent (darker on light themes, lighter on dark), with a white edge and a dark halo so it reads on light and dark surfaces alike
  const dark = isDark(s)
  const cur = cursors(toneOf(s.accent ?? (dark ? '#8479ff' : '#6a5cff'), dark ? 0.12 : -0.12))
  set('--cursor-arrow', cur.arrow)
  set('--cursor-hand', cur.hand)
  set('--cursor-text', cur.text)
  set('--cursor-grab', cur.grab)
  set('--cursor-grabbing', cur.grabbing)
  set('--cursor-zoom', cur.zoom)
  set('--cursor-nwse', cur.nwse)
  set('--cursor-nesw', cur.nesw)
  set('--cursor-ew', cur.ew)
  set('--radius', s.radius === DEFAULTS.radius ? null : s.radius + 'px')
  set('--radius-sm', s.radius === DEFAULTS.radius ? null : Math.max(3, Math.round(s.radius * 0.67)) + 'px')
  set('--radius-lg', s.radius === DEFAULTS.radius ? null : Math.round(s.radius * 1.33) + 'px')
  set('--editor-size', s.fontSize === DEFAULTS.fontSize ? null : s.fontSize + 'px')
  set('--editor-color', s.textColor)
  // boolean/enum switches are plain attributes on <html>; the stylesheet decides what they mean
  const flag = (k: string, on: boolean, v = '1') => (on ? root.setAttribute(k, v) : root.removeAttribute(k))
  flag('data-side', s.sidebar !== 'default', s.sidebar)
  set('--glass-side', s.sideGlass ? String(s.sideGlass / 100) : null)
  set('--glass-main', s.mainGlass ? String(s.mainGlass / 100) : null)
  flag('data-covers', !s.showCovers, 'off')
  flag('data-icons', !s.showIcons, 'off')
  flag('data-motion', s.reduceMotion, 'reduce')

  const f = FONTS.find((x) => x.id === s.font) ?? FONTS[0]
  set('--font', f.id === 'vazir' ? null : f.stack)
  loadFont(f)

  void applyBackground(root, s.bg, s.bgStrength)
}

apply()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (apply(), subs.forEach((f) => f())))
