/**
 * Nevis design system — scenery.
 * Abstract, minimal landscapes drawn as layered flat silhouettes over a sky gradient: pure CSS and inline SVG, so they
 * cost no storage and survive backup and restore untouched. Used for the page covers and for the Home banner,
 * which paints the sky of the current time of day. Pure data: no React, no imports.
 */

// Silhouettes are bottom-anchored paths in a 1200 × 400 box that is stretched to fill, so keep them abstract.
const RIDGE_A = 'M0 400V250L130 160 230 240 380 90 520 230 640 150 800 260 930 170 1080 250 1200 190V400Z'
const RIDGE_B = 'M0 400V300L160 215 290 285 450 185 600 290 760 205 920 295 1060 230 1200 285V400Z'
const PEAK = 'M0 400V320L240 320 520 70 720 250 830 200 1010 320 1200 320V400Z'
const TWIN = 'M0 400V330L200 330 380 120 560 330 640 330 820 160 1000 330 1200 330V400Z'
const ROLL = 'M0 400V330c150-40 300-40 450 0s300 40 450-10 200-20 300-5V400z'
const SWELL = 'M0 400V270c160-70 320-70 480-10s320 70 480-10 160-30 240-10V400z'
const DUNE_A = 'M0 400V300c200-90 380-20 560-20s420 80 640-20V400z'
const DUNE_B = 'M0 400V350c220-70 420-20 620-10s400 50 580-20V400z'

/** `drop` sinks the silhouette (in box units) so the sky above it stays clear for text. */
const ridge = (fill: string, d: string, opacity = 1, drop = 0) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 400' preserveAspectRatio='none'><path transform='translate(0 ${drop})' fill='${fill}' fill-opacity='${opacity}' d='${d}'/></svg>`)}")`

const sky = (...stops: string[]) => `linear-gradient(180deg, ${stops.join(', ')})`

/** The sun or the moon: a round core with a soft halo (CSS keeps it round however the scene is stretched). */
const orb = (x: number, y: number, r: number, core: string, halo: string) => `radial-gradient(circle at ${x}% ${y}%, ${core} 0, ${core} ${r}px, ${halo} ${r + 1}px, transparent ${r * 3.2}px)`

const stars = [
  [12, 18],
  [24, 34],
  [38, 12],
  [47, 30],
  [58, 20],
  [66, 38],
  [88, 14],
  [93, 34],
  [8, 40],
  [31, 22],
]
  .map(([x, y], i) => `radial-gradient(${i % 3 ? 1 : 1.5}px ${i % 3 ? 1 : 1.5}px at ${x}% ${y}%, #fff 50%, transparent)`)
  .join(', ')

/** Layers far to near; the sun sits behind every ridge, and `top` paints over the ridges (a lake, for instance). */
const scene = (skyCss: string, ridges: [string, string, number?][], behind: string[] = [], top: string[] = [], drop = 0) =>
  [...top, ...ridges.map(([fill, d, opacity]) => ridge(fill, d, opacity, drop)).reverse(), ...behind, skyCss].join(', ')

export interface Scenic {
  id: string
  label: string
  css: string
  dark: boolean
}

/** The abstract landscape covers the cover picker offers after the colour washes. */
export const COVER_SCENES: Scenic[] = [
  {
    id: 'ds-misty',
    label: 'Misty mountains',
    dark: false,
    css: scene(
      sky('#f4ede7', '#dfe7ee'),
      [
        ['#cdd7e2', RIDGE_A],
        ['#aebfd0', RIDGE_B],
        ['#8fa6bb', ROLL],
      ],
      [orb(72, 34, 18, '#fff7e6', 'rgba(255,240,215,0.55)')],
    ),
  },
  {
    id: 'ds-snow',
    label: 'Snow peaks',
    dark: false,
    css: scene(
      sky('#bcd8f2', '#f4f9fd'),
      [
        ['#8fb0d1', RIDGE_A],
        ['#f1f6fb', RIDGE_B],
        ['#d6e4f2', ROLL],
      ],
      [orb(20, 30, 16, '#ffffff', 'rgba(255,255,255,0.6)')],
    ),
  },
  {
    id: 'ds-sunset-ridge',
    label: 'Sunset ridge',
    dark: true,
    css: scene(
      sky('#2e2150', '#b4507a 55%', '#ffad6b'),
      [
        ['#4a3270', RIDGE_A],
        ['#33224f', RIDGE_B],
        ['#1f1535', ROLL],
      ],
      [orb(30, 74, 30, '#fff0c2', 'rgba(255,170,100,0.7)')],
    ),
  },
  {
    id: 'ds-moonlit',
    label: 'Moonlit peaks',
    dark: true,
    css: scene(
      sky('#080e2a', '#1b2b62 80%', '#2a3a78'),
      [
        ['#26376e', RIDGE_A],
        ['#182650', RIDGE_B],
        ['#0e1737', ROLL],
      ],
      [orb(80, 24, 15, '#f4f1e0', 'rgba(200,210,255,0.3)'), stars],
    ),
  },
  {
    id: 'ds-dunes',
    label: 'Golden dunes',
    dark: false,
    css: scene(
      sky('#ffe9bf', '#ffcf94'),
      [
        ['#efb56f', DUNE_A],
        ['#da9650', DUNE_B],
      ],
      [orb(70, 38, 22, '#fff4d6', 'rgba(255,225,160,0.6)')],
    ),
  },
  {
    id: 'ds-blue-hour',
    label: 'Blue hour',
    dark: true,
    css: scene(sky('#233068', '#7d78c0 55%', '#f2b9a3'), [
      ['#4b5894', TWIN],
      ['#323f78', RIDGE_B],
      ['#222c5c', ROLL],
    ]),
  },
  {
    id: 'ds-sage-hills',
    label: 'Sage hills',
    dark: false,
    css: scene(
      sky('#f1f6ec', '#dcebd5'),
      [
        ['#b3cfaa', SWELL],
        ['#8db38c', ROLL],
        ['#6a9a7a', DUNE_B],
      ],
      [orb(25, 30, 18, '#fffbe6', 'rgba(255,248,200,0.55)')],
    ),
  },
  {
    id: 'ds-rose-mountain',
    label: 'Rose mountain',
    dark: false,
    css: scene(sky('#ffe5ec', '#ffd2c6'), [
      ['#d28a98', PEAK],
      ['#b36483', RIDGE_B],
      ['#85456b', ROLL],
    ]),
  },
  {
    id: 'ds-ink-wash',
    label: 'Ink wash',
    dark: false,
    css: scene(
      sky('#f4efe6', '#ece5d8'),
      [
        ['#2f3a44', RIDGE_A, 0.22],
        ['#2f3a44', RIDGE_B, 0.42],
        ['#2f3a44', ROLL, 0.7],
      ],
      [orb(76, 26, 14, '#c0524a', 'rgba(192,82,74,0.12)')],
    ),
  },
  {
    id: 'ds-mirror-lake',
    label: 'Mirror lake',
    dark: false,
    css: scene(
      sky('#dcecf7', '#f7f1e6'),
      [
        ['#7890ad', RIDGE_A],
        ['#5f7b9b', TWIN],
      ],
      [orb(66, 30, 16, '#fffaf0', 'rgba(255,244,220,0.5)')],
      ['linear-gradient(180deg, transparent 0 66%, #bcd4e6 66%, #d9e8f2)'],
    ),
  },
  {
    id: 'ds-aurora-peaks',
    label: 'Aurora peaks',
    dark: true,
    css: scene(
      sky('#050d1c', '#0b3a4a'),
      [
        ['#0c1e33', RIDGE_A],
        ['#081525', RIDGE_B],
        ['#050d18', ROLL],
      ],
      ['radial-gradient(ellipse at 30% 22%, rgba(80,255,190,0.42), transparent 55%)', 'radial-gradient(ellipse at 72% 14%, rgba(120,170,255,0.32), transparent 50%)', stars],
    ),
  },
]

export type DayPhase = 'dawn' | 'morning' | 'afternoon' | 'sunset' | 'night'
export interface Landscape {
  phase: DayPhase
  css: string
  dark: boolean
}

export const phaseOf = (hour: number): DayPhase =>
  hour >= 5 && hour < 8 ? 'dawn' : hour >= 8 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 20 ? 'sunset' : 'night'

/** The Home banner: one minimal landscape per time of day, so the page quietly follows the clock. `dark` says text on it should be light. */
export const landscapeFor = (hour: number): Landscape => {
  const phase = phaseOf(hour)
  switch (phase) {
    case 'dawn':
      return {
        phase,
        dark: false,
        css: scene(
          sky('#ffd9c0', '#ffb8a0 55%', '#d9a5c8'),
          [
            ['#c9a3c4', RIDGE_A],
            ['#a985b5', RIDGE_B],
            ['#8369a6', ROLL],
          ],
          [orb(70, 66, 26, '#fff3d6', 'rgba(255,214,170,0.65)')],
          [],
          80,
        ),
      }
    case 'morning':
      return {
        phase,
        dark: false,
        css: scene(
          sky('#bfe3f5', '#e8f4ee 62%', '#fdf3df'),
          [
            ['#b9d3d8', RIDGE_A],
            ['#97bfb6', RIDGE_B],
            ['#6fa593', ROLL],
          ],
          [orb(78, 30, 22, '#fffbe6', 'rgba(255,240,190,0.7)')],
          [],
          80,
        ),
      }
    case 'afternoon':
      return {
        phase,
        dark: false,
        css: scene(
          sky('#6db3ee', '#a9d4f5 55%', '#e6f2fb'),
          [
            ['#7fa4cf', RIDGE_A],
            ['#5f86b8', RIDGE_B],
            ['#47709f', ROLL],
          ],
          [orb(28, 24, 22, '#fffdf0', 'rgba(255,255,230,0.6)')],
          [],
          80,
        ),
      }
    case 'sunset':
      return {
        phase,
        dark: true,
        css: scene(
          sky('#4a3a8a', '#c8607f 50%', '#ffad6b'),
          [
            ['#6a4a95', RIDGE_A],
            ['#4d3577', RIDGE_B],
            ['#32235a', ROLL],
          ],
          [orb(62, 72, 34, '#fff0c2', 'rgba(255,170,100,0.7)')],
          [],
          80,
        ),
      }
    default:
      return {
        phase,
        dark: true,
        css: scene(
          sky('#0a1030', '#1a2a60 70%', '#2c3b7a'),
          [
            ['#243468', RIDGE_A],
            ['#18244f', RIDGE_B],
            ['#0f1838', ROLL],
          ],
          [orb(78, 26, 16, '#f4f1e0', 'rgba(200,210,255,0.35)'), stars],
          [],
          80,
        ),
      }
  }
}
