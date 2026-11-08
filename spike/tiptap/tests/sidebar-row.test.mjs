// The sidebar row's tools float over the end of the title. These tests read the real stylesheets and pin
// the rules that keep the title and the tools from overlapping in either interface direction.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = (f) => readFileSync(new URL(`../src/design-system/areas/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
const meta = css('page-meta.css')
const shell = css('shell.css')
const rules = (text) => [...text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body: body.trim() }))
const all = [...rules(meta), ...rules(shell)]
const maskRules = all.filter((r) => /\.ntitle/.test(r.sel) && /mask-image/.test(r.body))
const dir = (r) => r.body.match(/linear-gradient\(to (left|right)/)?.[1]

test('the fade direction follows the interface direction, never the title text direction', () => {
  assert.ok(maskRules.length >= 3, 'hover/focus, rtl and no-hover rules exist')
  for (const r of maskRules) assert.ok(!/:dir\(/.test(r.sel), `${r.sel} must not key on the text direction`)
  for (const r of maskRules) {
    const rtl = /\[dir='rtl'\]/.test(r.sel)
    assert.equal(dir(r), rtl ? 'right' : 'left', `${r.sel}: tools sit at the ${rtl ? 'left' : 'right'}, so the fade starts there`)
  }
})

test('the fade covers every state in which the tools are visible', () => {
  const selectors = maskRules.map((r) => r.sel).join(' | ')
  for (const state of [':hover', ':focus-within']) assert.ok(selectors.includes(state), `fade on ${state}`)
  assert.ok(/@media \(hover: none\)[^{]*\{[^}]*\.ntitle[^}]*mask-image/.test(meta), 'fade where the tools are always shown')
  assert.ok(/@media \(hover: none\)[^{]*\{[^}]*\.acts[^}]*display: flex/.test(shell), 'tools always shown without hover')
  assert.ok(/\.row:focus-within \.acts/.test(shell), 'tools shown for keyboard focus')
})

test('the faded width equals the tools width', () => {
  const width = meta.match(/--acts-w:\s*calc\(([^;]+)\);/)?.[1].replace(/\s+/g, ' ')
  assert.equal(width, '2 * var(--ds-control-sm) + 3 * var(--ds-s1)', 'two buttons, two gaps/margins and the end offset')
  const button = all.find((r) => r.sel === '.acts button')
  assert.ok(/width: var\(--ds-control-sm\)/.test(button.body), 'a tool is control-sm wide, as the fade assumes')
  const acts = all.find((r) => r.sel === '.acts')
  assert.ok(/gap: var\(--ds-s1\)/.test(acts.body))
  const placed = all.find((r) => /\.tree-in \.row \.acts$/.test(r.sel))
  assert.ok(/inset-inline-end: var\(--ds-s1\)/.test(placed.body) && /margin: 0/.test(placed.body), 'offset is the one the width counts')
})

test('the tools have no box of their own and use logical properties only', () => {
  const placed = all.find((r) => /\.tree-in \.row \.acts$/.test(r.sel))
  assert.ok(/background: none/.test(placed.body), 'no second background inside the row hover')
  assert.ok(/background: none/.test(all.find((r) => r.sel === '.acts button:hover').body))
  for (const r of [placed, ...all.filter((x) => /\.acts/.test(x.sel))]) assert.ok(!/(?:^|[;\s])(?:left|right)\s*:/.test(r.body), `${r.sel} uses logical offsets`)
})

test('the tool buttons are named for assistive technology', () => {
  const tsx = readFileSync(new URL('../src/PageTree.tsx', import.meta.url), 'utf8')
  const buttons = [...tsx.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((b) => /title=\{/.test(b))
  assert.ok(buttons.length >= 5)
  for (const b of buttons) assert.ok(/aria-label=/.test(b), `${b} needs an aria-label`)
})
