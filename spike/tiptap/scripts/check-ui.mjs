// UI guard: keeps new code on the design system (docs/design-system.md).
// Existing violations are recorded in ui-guard-baseline.json and may only go down:
// a new violation fails, and so does a baseline that has become too generous.
//   npm run check:ui              check
//   npm run check:ui -- --update  rewrite the baseline after fixing violations
// A line containing `ui-allow` (or directly under one) is skipped; name the rule and say why: ui-allow physical-direction: reason.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')
const baselineFile = join(here, 'ui-guard-baseline.json')

const LEGACY_VARS = ['bg', 'side-bg', 'bg-raised', 'bg-sunk', 'text', 'muted', 'faint', 'border', 'border-strong', 'hover', 'active', 'accent', 'accent-bg', 'danger', 'ok', 'warn', 'radius-sm', 'radius', 'radius-lg', 'pop', 'shadow']

export const RULES = {
  // a <button> with its own area class (a tab, a row action, a toolbar item) is a custom control; a standard button is the component
  'raw-button': { why: 'Use Button or IconButton from the design system instead of a <button> with ds-btn / ds-icon-btn classes.', files: 'tsx', skipDesignSystem: true, pattern: /<button\b[^>]*\bclassName="[^"]*\bds-(?:btn|icon-btn)\b/g },
  // the design system takes text, data and callbacks as props; the app wires it up (iconSet and textDirection are pure data helpers)
  'app-import': { why: 'The design system must not import app code. Pass values and callbacks in, or register a hook (see text.ts).', files: 'any', onlyDesignSystem: true, except: /Gallery\.tsx$/, pattern: /(?:from|import\()\s*'\.\.\/(?!(?:iconSet|textDirection)')/g },
  'raw-select': { why: 'Use Dropdown, never a native <select>.', files: 'tsx', skipDesignSystem: true, pattern: /<select\b/g },
  'physical-direction': { why: 'Use logical properties (inline-start/end, text-align: start) so RTL needs no overrides.', files: 'css',
    pattern: /(?:^|[;{\s])(?:margin-(?:left|right)|padding-(?:left|right)|border-(?:left|right)(?:-[a-z]+)?)\s*:|text-align\s*:\s*(?:left|right)\b|(?:^|[;{\s])(?:left|right)\s*:/g },
  'hard-coded-color': { why: 'Use a design token (var(--ds-...)), not a literal color.', files: 'css', skipTokens: true, pattern: /#[0-9a-fA-F]{3,8}\b/g },
  'legacy-token': { why: 'Use the --ds-* token (mapping table in docs/design-system.md), not the legacy variable.', files: 'any',
    pattern: new RegExp(`var\\(--(?:${LEGACY_VARS.join('|')})\\s*[,)]`, 'g') },
}

const blankComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** Violations per rule for one file's text. `name` decides which rules apply. */
export function scanSource(name, text) {
  const norm = name.split(sep).join('/')
  const kind = norm.endsWith('.tsx') ? 'tsx' : norm.endsWith('.ts') ? 'ts' : norm.endsWith('.css') ? 'css' : null
  if (!kind) return {}
  const designSystem = norm.startsWith('design-system/')
  const tokens = /(^|\/)(tokens|print)\.css$/.test(norm) // token files and the print palette are where literal colors belong
  const lines = text.split('\n')
  // `ui-allow` skips every rule on its line and the next; `ui-allow rule-name` skips only that rule.
  const allowed = new Map()
  lines.forEach((line, i) => {
    const m = line.match(/ui-allow(?: ([a-z,-]+))?/)
    if (m) for (const at of [i, i + 1]) allowed.set(at, m[1] ? new Set(m[1].split(',')) : null)
  })
  const body = (kind === 'css' ? blankComments(text) : text).split('\n')
  const counts = {}
  for (const [rule, def] of Object.entries(RULES)) {
    if (def.files !== 'any' && def.files !== kind) continue
    if (def.skipDesignSystem && designSystem) continue
    if (def.onlyDesignSystem && !designSystem) continue
    if (def.except?.test(norm)) continue
    if (def.skipTokens && tokens) continue
    let n = 0
    body.forEach((line, i) => { if (!(allowed.has(i) && (allowed.get(i) === null || allowed.get(i).has(rule)))) n += (line.match(def.pattern) ?? []).length })
    if (n) counts[rule] = n
  }
  return counts
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

export function scanAll(root = src) {
  const result = {}
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/')
    for (const [rule, n] of Object.entries(scanSource(rel, readFileSync(file, 'utf8')))) (result[rule] ??= {})[rel] = n
  }
  return result
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'object' ? sorted(v) : v]))

function main() {
  const actual = scanAll()
  if (process.argv.includes('--update')) {
    writeFileSync(baselineFile, JSON.stringify(sorted(actual), null, 2) + '\n')
    const total = Object.values(actual).flatMap((files) => Object.values(files)).reduce((a, b) => a + b, 0)
    console.log(`Baseline written: ${total} existing violations.`)
    return
  }
  let baseline = {}
  try { baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) } catch { /* no baseline yet: everything counts */ }
  const worse = [], better = []
  for (const rule of Object.keys(RULES)) {
    const files = new Set([...Object.keys(actual[rule] ?? {}), ...Object.keys(baseline[rule] ?? {})])
    for (const file of files) {
      const now = actual[rule]?.[file] ?? 0, was = baseline[rule]?.[file] ?? 0
      if (now > was) worse.push(`${file}: ${rule} ${was} -> ${now}. ${RULES[rule].why}`)
      else if (now < was) better.push(`${file}: ${rule} ${was} -> ${now}`)
    }
  }
  if (worse.length) {
    console.error('UI guard: new violations of the design system.\n  ' + worse.join('\n  '))
    console.error('\nFix them, or add `ui-allow` with a reason on that line if it is truly physical or one-off.')
  }
  if (better.length) {
    console.error((worse.length ? '\n' : '') + 'UI guard: fewer violations than the baseline (good). Lock it in:\n  ' + better.join('\n  ') + '\n\nRun: npm run check:ui -- --update')
  }
  if (worse.length || better.length) process.exit(1)
  const total = Object.values(actual).flatMap((files) => Object.values(files)).reduce((a, b) => a + b, 0)
  console.log(`UI guard: ok (${total} existing violations remain in the baseline).`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
