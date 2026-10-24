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
  reduceMotion: boolean
}

export const DEFAULTS: Settings = { lang: 'en', dir: 'auto', theme: 'light', accent: null, bg: { kind: 'default' }, radius: 12, font: 'vazir', fontSize: 16, textColor: null, sidebar: 'default', glass: false, showCovers: true, showIcons: true, reduceMotion: false }

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

/** Soft glows that sit behind the sidebar; [light-mode, dark-mode] colour pairs. */
export const PRESETS: { id: string; label: string; light: [string, string]; dark: [string, string] }[] = [
  { id: 'aurora', label: 'Aurora', light: ['rgba(150,130,255,.30)', 'rgba(120,170,255,.26)'], dark: ['rgba(100,80,230,.28)', 'rgba(40,110,220,.2)'] },
  { id: 'sunset', label: 'Sunset', light: ['rgba(255,150,120,.30)', 'rgba(255,200,110,.26)'], dark: ['rgba(230,90,80,.24)', 'rgba(240,150,60,.16)'] },
  { id: 'forest', label: 'Forest', light: ['rgba(90,200,150,.28)', 'rgba(120,200,220,.24)'], dark: ['rgba(30,160,110,.22)', 'rgba(30,120,150,.18)'] },
  { id: 'ocean', label: 'Ocean', light: ['rgba(90,170,255,.30)', 'rgba(90,220,230,.24)'], dark: ['rgba(30,110,230,.26)', 'rgba(20,170,200,.16)'] },
  { id: 'rose', label: 'Rose', light: ['rgba(255,130,190,.28)', 'rgba(190,140,255,.26)'], dark: ['rgba(220,60,150,.22)', 'rgba(130,70,230,.2)'] },
]

const glow = ([a, b]: [string, string]) => `radial-gradient(900px 560px at 0% 0%, ${a}, transparent 62%), radial-gradient(800px 560px at 100% 100%, ${b}, transparent 62%)`

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

const loadedFonts = new Set<FontId>()

export function apply(s: Settings = state) {
  const root = document.documentElement
  s.theme === 'system' ? delete root.dataset.theme : (root.dataset.theme = s.theme)
  root.lang = s.lang
  root.dir = s.dir === 'auto' ? (s.lang === 'fa' ? 'rtl' : 'ltr') : s.dir

  const set = (k: string, v: string | null) => (v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v))
  set('--accent', s.accent)
  set('--accent-on', s.accent ? onAccent(s.accent) : null)
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
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => subs.forEach((f) => f()))
