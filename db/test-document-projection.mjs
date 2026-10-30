import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { documentText, projectSearchDocument, searchWords } from '../spike/tiptap/src/documents/searchProjection.ts'
import { normalizeFa } from '../spike/tiptap/src/documents/normalize.ts'

const pages = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
const legacyText = (node) => !node || typeof node === 'string' ? '' : node.text ?? (node.content ?? []).map(legacyText).join(' ')

// The caller supplies pages explicitly; projection has no storage or platform access.
const memoryIndex = {
  rows: new Map(),
  update(input) { for (const page of input) this.rows.set(page.id, projectSearchDocument(page)) },
}

test('fixture pages retain the existing index payload through an injected memory adapter', () => {
  memoryIndex.update(pages)
  for (const page of pages) {
    assert.deepEqual(memoryIndex.rows.get(page.id), {
      id: page.id, updated: page.updatedAt,
      title: normalizeFa(page.title), tags: normalizeFa(page.tags.join(' ')),
      body: normalizeFa(legacyText(page.content)),
    })
  }
})

test('projection retains source JSON and original language text', () => {
  const before = JSON.stringify(pages)
  const original = documentText(pages[1].content)
  assert.ok(original.includes('كلاس'))
  assert.ok(original.includes('۱۲۳'))
  assert.ok(original.includes('برنامه‌نویسی'))
  projectSearchDocument(pages[1])
  assert.equal(JSON.stringify(pages), before)
})

test('query words keep normalization, whitespace and punctuation semantics', () => {
  assert.deepEqual(searchWords('  كلاس\t۱۲۳\nCount++  '), ['کلاس', '123', 'count++'])
  assert.deepEqual(searchWords('برنامه‌نویسی'), ['برنامه', 'نویسی'])
  assert.deepEqual(searchWords(' \n '), [])
})

test('empty and malformed document boundaries fail to empty text without platform access', () => {
  for (const value of [null, undefined, '', 123, {}, { content: null }, { content: 'bad' }, { text: 12 }]) assert.equal(documentText(value), '')
  assert.equal(documentText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a b')
})

test('attribute-only extraction remains an explicit deferred projection change', () => {
  assert.equal(documentText({ type: 'mathBlock', attrs: { latex: 'E = mc^2' } }), '')
  assert.equal(documentText({ type: 'mermaid', attrs: { code: 'flowchart LR' } }), '')
})
