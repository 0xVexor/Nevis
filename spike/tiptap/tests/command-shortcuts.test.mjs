import assert from 'node:assert/strict'
import test from 'node:test'
import { commandMatches } from '../src/shortcutCommands.ts'
import { pauseBindings } from '../src/shortcutBindings.ts'

test('editor and review shortcuts use physical keys and pause during recording', () => {
  const bold = { code: 'KeyB', key: 'ب', ctrlKey: true }
  assert.equal(commandMatches(bold, 'Bold'), true)
  assert.equal(commandMatches({ code: 'Digit1', key: '۱' }, 'Again'), true)
  assert.equal(commandMatches({ ...bold, isComposing: true }, 'Bold'), false)
  const resume = pauseBindings()
  try {
    assert.equal(commandMatches(bold, 'Bold'), false)
  } finally {
    resume()
  }
  assert.equal(commandMatches(bold, 'Bold'), true)
})

test('the editor command catalog starts with writing and keeps code languages searchable', async () => {
  globalThis.window = { addEventListener() {}, dispatchEvent() {} }
  globalThis.localStorage = { getItem() { return null }, setItem() {} }
  globalThis.document = { documentElement: { dataset: {}, style: {} }, body: {} }
  globalThis.getComputedStyle = () => ({ colorScheme: 'light' })
  globalThis.MutationObserver = class { observe() {} }
  await import('../src/editor/extensions.ts')
  const { editorSearchItems } = await import('../src/editor/slash.ts')
  const items = editorSearchItems()
  assert.deepEqual(items.slice(0, 4).map(item => item.title), ['Text', 'Heading 1', 'Heading 2', 'Heading 3'])
  assert.ok(items.some(item => item.item.title === 'Code {name}' && item.searchOnly))
  assert.ok(items.some(item => item.title === 'Code block' && !item.searchOnly))
})
