import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSource } from '../scripts/check-ui.mjs'

test('flags buttons that should be the component, and native selects, in screens only', () => {
  assert.deepEqual(scanSource('Page.tsx', '<button className="ds-btn ds-btn--primary" onClick={a}>x</button><select />'), { 'raw-button': 1, 'raw-select': 1 })
  assert.deepEqual(scanSource('Page.tsx', '<button className="twisty" onClick={a}>x</button><button onClick={b}>y</button>'), {}, 'custom controls keep their own class')
  assert.deepEqual(scanSource('design-system/Button.tsx', '<button className="ds-btn" />'), {})
})

test('flags physical CSS but not logical or commented CSS', () => {
  const css = '.a { margin-left: 4px; text-align: left; left: 0; margin-inline-start: 4px; inset-inline-start: 0 }\n/* right: 0; */'
  assert.deepEqual(scanSource('x.css', css), { 'physical-direction': 3 })
})

test('flags literal colors outside token files and legacy variables everywhere', () => {
  assert.deepEqual(scanSource('x.css', '.a { color: #fff; background: var(--bg); border: 1px solid var(--ds-line); color: var(--text-2) }'), { 'hard-coded-color': 1, 'legacy-token': 1 })
  assert.deepEqual(scanSource('design-system/tokens.css', ':root { --ds-bg: #fafafa }'), {})
})

test('ui-allow skips its own line and the next one', () => {
  assert.deepEqual(scanSource('x.css', '/* ui-allow: physical geometry */\n.a { left: 0 }\n.b { left: 0 }'), { 'physical-direction': 1 })
  assert.deepEqual(scanSource('x.css', '.a { left: 0 } /* ui-allow */'), {})
})

test('ui-allow with a rule name skips only that rule', () => {
  assert.deepEqual(scanSource('x.css', '/* ui-allow physical-direction: geometry */\n.a { left: 0; color: #fff }'), { 'hard-coded-color': 1 })
})
