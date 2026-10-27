import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from './tests/tools/node_modules/ajv/dist/ajv.js'
import { documentToolContracts, ERROR_CODES, LIMITS } from '../spike/tiptap/src/documents/contracts.ts'

const ajv = new Ajv({ strict: true, allErrors: true })
const validators = Object.fromEntries(Object.entries(documentToolContracts).map(([name, contract]) => [name, {
  input: ajv.compile(contract.inputSchema), output: ajv.compile(contract.outputSchema),
}]))
const examples = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/contracts.json', import.meta.url), 'utf8'))
const validate = (tool, side, data) => {
  const check = validators[tool][side]
  assert.equal(check(data), true, JSON.stringify(check.errors))
}

test('all eight production contracts compile and have request/success fixtures', () => {
  assert.equal(Object.keys(validators).length, 8)
  assert.deepEqual(Object.keys(examples.tools).sort(), Object.keys(validators).sort())
  for (const [name, example] of Object.entries(examples.tools)) {
    validate(name, 'input', example.input)
    validate(name, 'output', example.output)
  }
})

test('stable error examples cover all codes for every tool', () => {
  assert.deepEqual(examples.errors.map(x => x.error.code).sort(), [...ERROR_CODES].sort())
  for (const name of Object.keys(validators)) for (const error of examples.errors) validate(name, 'output', error)
  assert.equal(validators.read_document.output({ ok: false, error: {
    code: 'ACCESS_DENIED', message: 'Access denied', retryable: false, details: { currentRevision: 'private' },
  } }), false)
})

test('reject scope injection, unknown fields, missing revisions and invalid budgets', () => {
  for (const name of Object.keys(validators)) {
    for (const field of ['vaultHandle', 'vaultPath', 'grantId', 'includeExcluded']) {
      assert.equal(validators[name].input({ ...examples.tools[name].input, [field]: 'forged' }), false)
    }
  }
  for (const name of ['edit_document', 'update_document_metadata', 'undo_document_edit']) {
    const { expectedRevision, ...missing } = examples.tools[name].input
    assert.equal(validators[name].input(missing), false)
  }
  for (const limit of [0, LIMITS.pageSize + 1, 1.5]) assert.equal(validators.list_documents.input({ limit }), false)
  assert.equal(validators.search_documents.input({ query: '', mode: 'literal' }), false)
  assert.equal(validators.read_document.input({ ...examples.tools.read_document.input, budget: { maxChars: 16001, maxBlocks: 1 } }), false)
})

test('all progressive operation shapes validate; arbitrary patches and raw links fail', () => {
  const base = examples.tools.edit_document.input
  const target = { from: { blockId: 'b1' }, through: { blockId: 'b2' } }
  const cases = [
    { kind: 'replace_blocks', target, blocks: [{ temporaryId: 'new', node: { type: 'paragraph' } }] },
    { kind: 'move_blocks', target, at: { position: 'end', parent: null } },
    { kind: 'delete_blocks', target },
    { kind: 'set_attributes', target: { blockId: 'b1' }, attributes: { dir: 'rtl' } },
    { kind: 'set_internal_link', target: { temporaryId: 'new' }, destinationDocumentId: 'd2', label: 'پیوند' },
  ]
  for (const operation of cases) validate('edit_document', 'input', { ...base, operations: [operation] })
  for (const operation of [
    { kind: 'set_attributes', target: { blockId: 'b1' }, attributes: { vaultPath: '/tmp' } },
    { kind: 'set_internal_link', target: { blockId: 'b1' }, href: 'nevis://d2' },
    { kind: 'delete_blocks', target: { from: { blockId: 'b1', temporaryId: 'new' }, through: { blockId: 'b2' } } },
  ]) assert.equal(validators.edit_document.input({ ...base, operations: [operation] }), false)
  assert.equal(validators.edit_document.input({ ...base, operations: [] }), false)
  assert.equal(validators.edit_document.input({ ...base, operations: Array(101).fill(cases[2]) }), false)
  assert.equal(validators.update_document_metadata.input({ ...examples.tools.update_document_metadata.input, patch: {} }), false)
})

test('preview and saved receipts have distinct output shapes', () => {
  validate('edit_document', 'output', { ok: true, result: { mode: 'apply', saved: examples.tools.create_document.output.result } })
  const preview = structuredClone(examples.tools.edit_document.output)
  preview.result.persisted = true
  assert.equal(validators.edit_document.output(preview), false)
  const saved = structuredClone(examples.tools.create_document.output)
  delete saved.result.receipt.afterRevision
  assert.equal(validators.create_document.output(saved), false)
  assert.equal(validators.read_document.output({ ok: false, error: { code: 'UNKNOWN', message: 'failure', retryable: false } }), false)
})

test('rich fixture content remains intact through the structured read contract', () => {
  const pages = JSON.parse(readFileSync(new URL('./fixtures/agent-documents/pages.json', import.meta.url), 'utf8'))
  for (const page of pages) {
    const blocks = page.content.content
    const before = JSON.stringify(blocks)
    for (let offset = 0; offset < blocks.length; offset += 100) {
      const result = structuredClone(examples.tools.read_document.output)
      result.result.chunks[0].structured = blocks.slice(offset, offset + 100)
      result.result.truncated = offset + 100 < blocks.length
      result.result.nextCursor = result.result.truncated ? 'opaque-continuation' : null
      validate('read_document', 'output', result)
    }
    assert.equal(JSON.stringify(blocks), before)
  }
})
