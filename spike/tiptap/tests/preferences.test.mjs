import test from 'node:test'
import assert from 'node:assert/strict'
import { rebasePreferences, preferenceKey } from '../src/preferencesModel.ts'
const p = (theme, lang) => ({ 'not.settings': JSON.stringify({ theme, lang }) })
test('settings changed while saving rebase onto independent remote fields', () => {
  const merged = rebasePreferences(p('light','en'), p('dark','en'), p('light','fa'))
  assert.deepEqual(JSON.parse(merged['not.settings']), { lang: 'fa', theme: 'dark' })
})
test('fresh cache input stays local on a same-field conflict and defaults do not erase a new remote value', () => {
  assert.equal(JSON.parse(rebasePreferences(p('light','en'),p('dark','en'),p('system','en'))['not.settings']).theme, 'dark')
  assert.deepEqual(rebasePreferences({}, {'not.sideW':null}, {'not.sideW':'300'}), {'not.sideW':'300'})
})
test('object key order does not trigger repeated preference writes', () => assert.equal(preferenceKey({'a':'x','b':null}), preferenceKey({'b':null,'a':'x'})))
