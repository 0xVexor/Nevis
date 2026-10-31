/**
 * Nevis design system — backgrounds.
 * Pure CSS (gradients, patterns, small inline SVG), so they cost no storage and survive backup and restore untouched.
 * Used for page covers and for the app background. Pick by `id`; `dark` says the surface is dark, so text on it should be light.
 * Pure data: scripts read this file to build the live reference.
 */
export type BackgroundGroup = 'soft' | 'vivid' | 'dark' | 'pattern' | 'scene'

export interface Background {
  id: string
  label: string
  group: BackgroundGroup
  css: string
  dark: boolean
}

export const BACKGROUND_GROUPS: { id: BackgroundGroup; label: string }[] = [
  { id: 'soft', label: 'Soft' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'dark', label: 'Dark' },
  { id: 'pattern', label: 'Patterns' },
  { id: 'scene', label: 'Scenes' },
]

const mesh = (base: string, ...stops: [string, number, number][]) => [...stops.map(([c, x, y]) => `radial-gradient(at ${x}% ${y}%, ${c} 0, transparent 55%)`), base].join(', ')
const linear = (deg: number, ...stops: string[]) => `linear-gradient(${deg}deg, ${stops.join(', ')})`
const svg = (body: string, w = 1200, h = 400) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}' preserveAspectRatio='none'>${body}</svg>`)}")`
const hills = (fill: string, d: string) => svg(`<path fill='${fill}' d='${d}'/>`)
const H1 = 'M0 400V270c150-90 300-90 450-10s300 80 450-10 200-50 300-20V400z'
const H2 = 'M0 400V320c180-70 330-60 480 0s330 60 480-10 180-30 240-10V400z'
const H3 = 'M0 400V355c200-50 400-40 600 0s400 40 600-10V400z'
const PEAKS = 'M0 400V250l90-70 70 40 110-120 100 110 80-60 120 140 90-90 110 100 90-70 120 120 90-60 120 110V400z'

const plus = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><path d='M20 14v12M14 20h12' stroke='rgba(20,23,28,0.16)' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>")}")`

const soft = (id: string, label: string, base: string, ...stops: [string, number, number][]): Background => ({ id, label, group: 'soft', css: mesh(base, ...stops), dark: false })
const vivid = (id: string, label: string, base: string, ...stops: [string, number, number][]): Background => ({ id, label, group: 'vivid', css: mesh(base, ...stops), dark: true })
const dark = (id: string, label: string, css: string): Background => ({ id, label, group: 'dark', css, dark: true })
const pattern = (id: string, label: string, css: string, isDark = false): Background => ({ id, label, group: 'pattern', css, dark: isDark })

export const BACKGROUNDS: Background[] = [
  /* soft: pale meshes that sit quietly behind a title */
  soft('peach-mist', 'Peach mist', '#fff1e6', ['#ffd1a6', 15, 20], ['#ff9fb0', 88, 25], ['#ffe9a8', 50, 95], ['#d6b8ff', 8, 85]),
  soft('sky-mist', 'Sky mist', '#eaf4ff', ['#bfe0ff', 12, 18], ['#d6d2ff', 90, 20], ['#c8f3ff', 55, 98]),
  soft('mint-mist', 'Mint mist', '#eefaf3', ['#c7f0dc', 14, 22], ['#d7f5b8', 88, 18], ['#bfeaf0', 50, 100]),
  soft('lilac-mist', 'Lilac mist', '#f5f0ff', ['#e0d0ff', 14, 20], ['#ffd0ec', 90, 22], ['#cfe0ff', 52, 100]),
  soft('rose-mist', 'Rose mist', '#fff0f3', ['#ffd0da', 12, 20], ['#ffe0c8', 88, 24], ['#f0d0ff', 50, 100]),
  soft('butter-mist', 'Butter mist', '#fffbe8', ['#fff0a8', 14, 20], ['#ffd9b0', 90, 24], ['#e0f5c0', 50, 100]),
  soft('seafoam', 'Seafoam', '#ecfbf9', ['#bdf0e8', 12, 20], ['#c4e4ff', 88, 20], ['#d9f7d0', 50, 100]),
  soft('lavender-haze', 'Lavender haze', '#f3f1fb', ['#d9d2f5', 12, 20], ['#e8e0f9', 88, 20], ['#cfd8f5', 50, 100]),
  soft('sand', 'Sand', '#f7f1e8', ['#efe0c8', 12, 20], ['#f4d8c4', 88, 24], ['#e6e8d0', 50, 100]),
  soft('cloud', 'Cloud', '#f4f6f8', ['#e6ecf2', 14, 20], ['#eef0f6', 88, 22], ['#e2eaf0', 50, 100]),
  /* vivid: saturated colour for covers that lead the page */
  vivid('aurora', 'Aurora', '#5b4bd6', ['#ff8fd8', 10, 15], ['#7fb2ff', 88, 10], ['#a98bff', 55, 95], ['#7ff0ff', 8, 90]),
  vivid('liquid', 'Liquid', '#ff9a7a', ['#ff7a59', 14, 30], ['#ff4f9a', 60, 10], ['#8a4bff', 90, 70], ['#ffd36b', 30, 100]),
  vivid('lagoon', 'Lagoon', '#0b2a5a', ['#2fe0c8', 10, 20], ['#2f6bff', 88, 15], ['#00b3e6', 55, 100], ['#7a5cff', 6, 90]),
  vivid('candy', 'Candy', '#ff7ab8', ['#ffb36b', 12, 20], ['#c06bff', 88, 24], ['#6bd0ff', 50, 100]),
  vivid('citrus', 'Citrus', '#ffb020', ['#ffe066', 14, 20], ['#ff7a3d', 90, 24], ['#9be15d', 50, 100]),
  vivid('berry', 'Berry', '#7a1f5c', ['#ff4f9a', 14, 20], ['#8a4bff', 88, 24], ['#ff9a7a', 50, 100]),
  vivid('tropical', 'Tropical', '#0aa88f', ['#7cf0c0', 14, 20], ['#ffd36b', 88, 24], ['#2f9bff', 50, 100]),
  vivid('flare', 'Flare', '#ff4d4d', ['#ffb347', 14, 20], ['#ff4f9a', 88, 24], ['#7a5cff', 50, 100]),
  vivid('orchid', 'Orchid', '#8e44ad', ['#ff9fe5', 14, 20], ['#6a8bff', 88, 24], ['#e0a0ff', 50, 100]),
  { id: 'prism', label: 'Prism', group: 'vivid', dark: true, css: 'conic-gradient(from 210deg at 50% 120%, #ff6ec7, #ffb86b, #fff27a, #6bf2b4, #6bb8ff, #a77bff, #ff6ec7)' },
  /* dark: for pages that want the lights down */
  dark('midnight', 'Midnight', mesh('#0b0b24', ['#3a2fd6', 14, 20], ['#7a2fff', 88, 24], ['#2f6bff', 50, 110])),
  dark('ink', 'Ink', 'conic-gradient(from 160deg at 70% 130%, #2a2d4a, #0d0e14 30%, #1c1f38 60%, #0d0e14)'),
  dark('graphite', 'Graphite', mesh('#16181d', ['#2a2f38', 12, 20], ['#20242c', 88, 24], ['#303641', 50, 110])),
  dark('ember', 'Ember', mesh('#1a0f0f', ['#7a2410', 14, 20], ['#a8431a', 88, 24], ['#4a1030', 50, 110])),
  dark('deep-forest', 'Deep forest', mesh('#0b1a14', ['#165a40', 14, 20], ['#0f3d33', 88, 24], ['#1f6b4a', 50, 110])),
  dark('abyss', 'Abyss', mesh('#06121f', ['#0b3a66', 14, 20], ['#0a5a7a', 88, 24], ['#142a66', 50, 110])),
  dark('eclipse', 'Eclipse', mesh('#0d0a14', ['#4a2a7a', 70, 20], ['#2a1a4a', 14, 90], ['#1a0f2a', 50, 50])),
  dark('stars', 'Stars', 'radial-gradient(1.5px 1.5px at 12% 22%, #fff 50%, transparent), radial-gradient(1px 1px at 30% 60%, #fff 50%, transparent), radial-gradient(1.5px 1.5px at 55% 30%, #fff 50%, transparent), radial-gradient(1px 1px at 72% 70%, #fff 50%, transparent), radial-gradient(1.5px 1.5px at 88% 25%, #fff 50%, transparent), ' + mesh('#0b0b24', ['#3a2fd6', 20, 110], ['#7a2fff', 90, 110])),
  /* patterns: quiet texture, readable text on top */
  pattern('dots', 'Dots', 'radial-gradient(circle at 1px 1px, rgba(20,23,28,0.18) 1px, transparent 0) 0 0 / 18px 18px, #f6f7f8'),
  pattern('grid', 'Grid', 'linear-gradient(rgba(20,23,28,0.07) 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, rgba(20,23,28,0.07) 1px, transparent 1px) 0 0 / 28px 28px, #fafbfb'),
  pattern('lines', 'Lines', 'repeating-linear-gradient(0deg, rgba(20,23,28,0.07) 0 1px, transparent 1px 22px), #fafbfb'),
  pattern('diagonal', 'Diagonal', 'repeating-linear-gradient(45deg, rgba(20,23,28,0.06) 0 1px, transparent 1px 14px), #f6f7f8'),
  pattern('checker', 'Checker', 'conic-gradient(rgba(20,23,28,0.06) 25%, transparent 0 50%, rgba(20,23,28,0.06) 0 75%, transparent 0) 0 0 / 32px 32px, #fafbfb'),
  pattern('plus', 'Plus grid', plus + ' 0 0 / 40px 40px, #f8f9fa'),
  pattern('contour', 'Contour', 'repeating-radial-gradient(circle at 25% 130%, transparent 0 16px, rgba(20,23,28,0.1) 17px 18px), repeating-radial-gradient(circle at 80% -20%, transparent 0 22px, rgba(20,23,28,0.08) 23px 24px), #f6f8f7'),
  pattern('stripes', 'Stripes', 'repeating-linear-gradient(90deg, rgba(15,143,131,0.1) 0 18px, transparent 18px 36px), #f6fbfa'),
  pattern('dots-dark', 'Dots dark', 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.16) 1px, transparent 0) 0 0 / 18px 18px, #1b1e24', true),
  pattern('grid-dark', 'Grid dark', 'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px) 0 0 / 28px 28px, #171a1f', true),
  /* scenes: layered silhouettes, no image files */
  { id: 'dawn-hills', label: 'Dawn hills', group: 'scene', dark: false, css: [hills('#c79bb8', H3), hills('#a97fae', H2), hills('#8a68a0', H1), linear(180, '#ffd9a8 0%', '#ffb38a 45%', '#b987b5 100%')].join(', ') },
  { id: 'dusk-hills', label: 'Dusk hills', group: 'scene', dark: true, css: [hills('#1c2342', H3), hills('#2a3260', H2), hills('#3b4580', H1), linear(180, '#7a5fb0 0%', '#d98aa8 60%', '#ffb38a 100%')].join(', ') },
  { id: 'sea', label: 'Sunrise sea', group: 'scene', dark: false, css: [hills('#4f9bd0', H3), hills('#79b9e0', H2), linear(180, '#ffe3b0 0%', '#ffc29a 50%', '#9ccbe8 100%')].join(', ') },
  { id: 'peaks', label: 'Peaks', group: 'scene', dark: false, css: [hills('#41507a', PEAKS), hills('#6d7fa8', H2), linear(180, '#8fb6e8 0%', '#cfe0f2 55%', '#f6ead9 100%')].join(', ') },
]

const byId = new Map(BACKGROUNDS.map((b) => [b.id, b]))

/** The CSS `background` value for an id; unknown ids fall back to Aurora. */
export const backgroundCss = (id: string): string => (byId.get(id) ?? byId.get('aurora')!).css
export const backgroundOf = (id: string): Background => byId.get(id) ?? byId.get('aurora')!
