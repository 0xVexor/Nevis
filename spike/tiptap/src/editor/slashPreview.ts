// A small picture of what each "/" command writes, shown beside the menu (like Notion). Static, drawn from design tokens so
// it follows light/dark and the accent. The key is the command's English title; commands without a drawing show none.

const INK = 'var(--ds-text-2)'
const SOFT = 'var(--ds-line-strong)'
const ACCENT = 'var(--ds-accent)'
const TINT = 'var(--ds-accent-soft)'
const SUNK = 'var(--ds-sunk)'
const PAPER = 'var(--ds-raised)'

const bar = (x: number, y: number, w: number, h = 6, c = SOFT) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${c}"/>`
const lines = (x: number, y: number, widths: number[], gap = 13, h = 6, c = SOFT) => widths.map((w, i) => bar(x, y + i * gap, w, h, c)).join('')
const box = (x: number, y: number, w: number, h: number, fill = PAPER, r = 6, stroke = SOFT) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`
const label = (x: number, y: number, s: string, size = 10, c = INK, weight = 600) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${c}" font-family="var(--ds-font-ui)">${s}</text>`
const mono = (x: number, y: number, s: string, size = 9, c = INK) => `<text x="${x}" y="${y}" font-size="${size}" fill="${c}" font-family="var(--ds-font-mono)">${s}</text>`
const svg = (body: string) => `<svg viewBox="0 0 200 120" aria-hidden="true">${body}</svg>`

const heading = (h: number) => svg(bar(24, 26, 96, h, INK) + lines(24, 26 + h + 14, [152, 120, 140]))
const code = (name?: string) =>
  svg(
    box(16, 14, 168, 92, SUNK, 8) +
      (name ? label(24, 30, name, 9, INK, 600) : '') +
      mono(24, name ? 48 : 38, 'const x = 42', 10, ACCENT) +
      mono(24, name ? 64 : 54, 'print(x)', 10, INK) +
      mono(24, name ? 80 : 70, '// done', 10, SOFT),
  )
const table = () =>
  svg(
    box(20, 16, 160, 88, PAPER, 6) +
      `<rect x="20.5" y="16.5" width="159" height="22" rx="5.5" fill="${SUNK}"/>` +
      [60, 100, 140].map((x) => `<line x1="${x}" y1="16" x2="${x}" y2="104" stroke="${SOFT}"/>`).join('') +
      [38, 60, 82].map((y) => `<line x1="20" y1="${y}" x2="180" y2="${y}" stroke="${SOFT}"/>`).join('') +
      [26, 66, 106].map((x) => bar(x, 24, 24, 5, INK)).join(''),
  )
const image = (badge = '') =>
  svg(
    box(20, 14, 160, 92, SUNK, 8) +
      `<circle cx="140" cy="38" r="9" fill="${ACCENT}" opacity=".85"/>` +
      `<path d="M20 94 L66 52 L98 80 L124 62 L180 100 V98 a8 8 0 0 1 -8 8 H28 a8 8 0 0 1 -8 -8Z" fill="${TINT}" stroke="${SOFT}"/>` +
      badge,
  )
const callout = () =>
  svg(
    `<rect x="16" y="26" width="168" height="68" rx="10" fill="${TINT}" stroke="${ACCENT}" stroke-opacity=".35"/><circle cx="38" cy="48" r="9" fill="${ACCENT}"/>` +
      label(34.2, 52, '!', 11, 'var(--ds-accent-ink)', 700) +
      lines(56, 42, [104, 84], 14),
  )
const toggle = () =>
  svg(
    `<path d="M22 26 L34 33 L22 40Z" fill="${INK}" transform="rotate(90 28 33)"/>` +
      bar(44, 30, 92, 7, INK) +
      lines(60, 52, [96, 72, 84], 14) +
      `<line x1="48" y1="48" x2="48" y2="92" stroke="${SOFT}" stroke-width="2"/>`,
  )
const diagram = () =>
  svg(
    box(70, 12, 60, 24, TINT, 7, ACCENT) +
      box(16, 78, 60, 24, PAPER, 7) +
      box(124, 78, 60, 24, PAPER, 7) +
      `<path d="M100 36 V52 H46 V78 M100 36 V52 H154 V78" fill="none" stroke="${INK}" stroke-width="1.5"/>` +
      `<path d="M42 73 L46 79 L50 73 M150 73 L154 79 L158 73" fill="none" stroke="${INK}" stroke-width="1.5"/>` +
      bar(82, 21, 36, 5, ACCENT) +
      bar(28, 87, 36, 5) +
      bar(136, 87, 36, 5),
  )
const database = () =>
  svg(
    box(14, 16, 172, 88, PAPER, 8) +
      `<rect x="14.5" y="16.5" width="171" height="20" rx="7.5" fill="${SUNK}"/>` +
      bar(24, 24, 36, 5, INK) +
      bar(86, 24, 28, 5, INK) +
      bar(138, 24, 28, 5, INK) +
      [0, 1, 2]
        .map(
          (i) =>
            bar(24, 46 + i * 20, 44, 6) +
            `<rect x="86" y="${43 + i * 20}" width="34" height="12" rx="6" fill="${i === 1 ? TINT : SUNK}" stroke="${i === 1 ? ACCENT : SOFT}"/>` +
            bar(138, 46 + i * 20, 30, 6),
        )
        .join(''),
  )
const drawing = () =>
  svg(
    box(14, 14, 172, 92, PAPER, 8) +
      `<rect x="30" y="32" width="46" height="30" rx="6" fill="none" stroke="${INK}" stroke-width="2"/>` +
      `<circle cx="140" cy="76" r="16" fill="none" stroke="${ACCENT}" stroke-width="2"/>` +
      `<path d="M78 48 C104 48 108 62 126 70" fill="none" stroke="${INK}" stroke-width="2"/><path d="M120 62 L127 71 L117 73" fill="none" stroke="${INK}" stroke-width="2"/>` +
      `<path d="M32 88 q10 -14 20 0 t20 0" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>`,
  )
const quote = () => svg(`<rect x="24" y="28" width="4" height="64" rx="2" fill="${ACCENT}"/>` + lines(40, 34, [128, 112, 70], 18, 7, INK))
const rule = () => svg(lines(24, 20, [150, 110], 14) + `<line x1="24" y1="60" x2="176" y2="60" stroke="${INK}" stroke-width="2"/>` + lines(24, 76, [140, 120], 14))
const direction = (dir: 'rtl' | 'ltr' | 'auto') =>
  svg(
    dir === 'rtl'
      ? lines(46, 30, [130, 100, 116], 16, 7, INK) + `<path d="M176 14 H150 M156 9 L150 14 L156 19" fill="none" stroke="${ACCENT}" stroke-width="2"/>`
      : dir === 'ltr'
        ? lines(24, 30, [130, 100, 116], 16, 7, INK) + `<path d="M24 14 H50 M44 9 L50 14 L44 19" fill="none" stroke="${ACCENT}" stroke-width="2"/>`
        : lines(24, 26, [120, 88], 16, 7, INK) + lines(56, 66, [120, 88], 16, 7, INK) + label(168, 20, 'A', 12, ACCENT, 700),
  )

const PREVIEWS: Record<string, () => string> = {
  Text: () => svg(lines(24, 28, [152, 140, 100], 16, 7)),
  'Heading 1': () => heading(14),
  'Heading 2': () => heading(10),
  'Heading 3': () => heading(7),
  'Bulleted list': () => svg([0, 1, 2].map((i) => `<circle cx="30" cy="${34 + i * 22}" r="3.5" fill="${INK}"/>` + bar(44, 31 + i * 22, [112, 90, 100][i], 7)).join('')),
  'Numbered list': () => svg([0, 1, 2].map((i) => label(24, 38 + i * 22, `${i + 1}.`, 11, INK) + bar(44, 31 + i * 22, [112, 90, 100][i], 7)).join('')),
  Checklist: () =>
    svg(
      [0, 1, 2]
        .map(
          (i) =>
            `<rect x="24" y="${28 + i * 22}" width="13" height="13" rx="4" fill="${i === 0 ? ACCENT : PAPER}" stroke="${i === 0 ? ACCENT : INK}"/>` +
            (i === 0 ? `<path d="M27 35 l3 3 l5 -6" fill="none" stroke="var(--ds-accent-ink)" stroke-width="1.8"/>` : '') +
            bar(46, 31 + i * 22, [100, 86, 110][i], 7, i === 0 ? SOFT : INK),
        )
        .join(''),
    ),
  'Link to page': () =>
    svg(
      lines(24, 28, [150, 110], 16, 7) +
        box(24, 60, 108, 28, PAPER, 8) +
        `<rect x="34" y="68" width="11" height="13" rx="2" fill="none" stroke="${INK}"/>` +
        bar(54, 71, 62, 6, ACCENT) +
        `<line x1="54" y1="80" x2="116" y2="80" stroke="${ACCENT}"/>`,
    ),
  Callout: callout,
  'Wrap in callout': callout,
  Toggle: toggle,
  'Wrap in toggle': toggle,
  'Diagram (Mermaid)': diagram,
  'Turn selection into diagram': diagram,
  Database: database,
  Drawing: drawing,
  'Formula (block)': () =>
    svg(
      box(20, 22, 160, 76, SUNK, 10) +
        label(100, 50, 'e = mc²', 22, INK, 500).replace('<text', '<text text-anchor="middle"') +
        label(100, 82, '∑ xᵢ', 14, ACCENT, 500).replace('<text', '<text text-anchor="middle"'),
    ),
  'Formula (inline)': () =>
    svg(
      bar(20, 38, 62) +
        `<rect x="88" y="29" width="46" height="24" rx="7" fill="${TINT}" stroke="${ACCENT}"/>` +
        label(97, 46, 'x² + 1', 12, INK, 500) +
        bar(140, 38, 40) +
        lines(20, 66, [150, 100], 14),
    ),
  Quote: quote,
  'Code block': () => code(),
  'Code {name}': () => code(),
  Icon: () =>
    svg(
      bar(20, 56, 54) +
        `<circle cx="96" cy="59" r="13" fill="${TINT}" stroke="${ACCENT}"/><path d="M96 51 l2.6 5.4 5.9 .8 -4.3 4.1 1 5.9 -5.2 -2.8 -5.2 2.8 1 -5.9 -4.3 -4.1 5.9 -.8Z" fill="${ACCENT}"/>` +
        bar(118, 56, 62) +
        lines(20, 82, [140], 14),
    ),
  Table: table,
  Image: () => image(),
  'Image from link': () =>
    image(
      `<circle cx="160" cy="88" r="10" fill="${PAPER}" stroke="${SOFT}"/><path d="M156 90 a3 3 0 0 1 0 -4 l2 -2 M164 86 a3 3 0 0 1 0 4 l-2 2 M158 88 h4" fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round"/>`,
    ),
  Divider: rule,
  'Right-to-left (RTL)': () => direction('rtl'),
  'Left-to-right (LTR)': () => direction('ltr'),
  'Auto direction': () => direction('auto'),
}

/** The drawing for a command, or null. `name` is a code language, used by the "Code {name}" commands. */
export function slashPreview(title: string, name?: string): string | null {
  if (name && title === 'Code {name}') return code(name)
  return PREVIEWS[title]?.() ?? null
}
