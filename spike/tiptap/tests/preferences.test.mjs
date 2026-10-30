import test from 'node:test'
import assert from 'node:assert/strict'
import { preferenceKey } from '../src/preferencesModel.ts'
test('object key order does not trigger repeated preference writes', () => assert.equal(preferenceKey({'a':'x','b':null}), preferenceKey({'b':null,'a':'x'})))
test('a changed value changes the fingerprint, JSON spacing does not', () => {
  assert.notEqual(preferenceKey({ 'not.settings': '{"theme":"dark"}' }), preferenceKey({ 'not.settings': '{"theme":"light"}' }))
  assert.equal(preferenceKey({ 'not.settings': '{"a":1,"b":2}' }), preferenceKey({ 'not.settings': '{ "b": 2, "a": 1 }' }))
})
