import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { applyChoices, canonical, defaultChoices, diffConflict, diffPieces, wordPieces } from './conflictMerge.ts'

const p = (id, text, extra = {}) => ({ type: 'paragraph', attrs: { blockId: id, dir: 'auto' }, content: text ? [{ type: 'text', text }] : undefined, ...extra })
const doc = (...content) => ({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content })
const page = (title, content) => ({ id: 'p1', parentId: null, title, favorite: false, sort: 0, content, updatedAt: 1, deletedAt: null })
const marker = ({ base, local, remote, kept = 'local', lt = 'T', rt = 'T', bt = 'T' }) => ({
  format: 1, id: 'm1', pageId: 'p1', kind: 'edit', detectedAt: 5, detectedBy: { deviceId: 'a', deviceName: '' },
  base: base ? page(bt, base) : null,
  local: { page: page(lt, local), deviceId: 'a', deviceName: '', savedAt: 3 },
  remote: { page: page(rt, remote), deviceId: 'b', deviceName: '', savedAt: 4 },
  kept,
})
const kinds = (m) => diffConflict(m).rows.map((r) => r.kind)
const texts = (content) => content.content.map((b) => b.content?.[0]?.text ?? b.type)

const schema = new Schema({ nodes: {
  doc: { content: 'block+', attrs: { blockIdentityVersion: { default: 0 } } },
  text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*', attrs: { blockId: { default: null }, dir: { default: 'auto' } } },
  table: { group: 'block', content: 'paragraph+', attrs: { blockId: { default: null } } },
} })
const valid = (content) => { schema.nodeFromJSON(content).check(); return true }

test('classification table', () => {
  const base = doc(p('a', 'one'), p('b', 'two'), p('c', 'three'), p('d', 'four'), p('e', 'five'), p('f', 'six'))
  const local = doc(p('a', 'one'), p('b', 'two L'), p('c', 'three'), p('d', 'four L'), p('f', 'six'), p('n', 'new local'))
  const remote = doc(p('a', 'one'), p('b', 'two'), p('c', 'three R'), p('d', 'four R'), p('e', 'five'), p('f', 'six'))
  const diff = diffConflict(marker({ base, local, remote }))
  assert.deepEqual(diff.rows.map((r) => r.kind), ['unchanged', 'local-only', 'remote-only', 'both', 'deleted', 'unchanged', 'added'])
  assert.deepEqual(diff.rows.map((r) => r.preselected), [null, 'local', 'remote', null, 'local', null, 'local'])
  assert.deepEqual(diff.rows.map((r) => r.needsChoice), [false, false, false, true, false, false, false])
  assert.equal(diff.rows[4].by, 'local')
  assert.equal(diff.title.kind, 'unchanged')
  const merged = applyChoices(marker({ base, local, remote }), { b3: 'remote' })
  assert.deepEqual(texts(merged.content), ['one', 'two L', 'three R', 'four R', 'six', 'new local'])
  assert.equal(merged.side, null)
  assert.ok(valid(merged.content))
})

test('apply with all-left / all-right equals that side', () => {
  const base = doc(p('a', 'one'), p('b', 'two'))
  const local = doc(p('b', 'two L'), p('a', 'one'), p('z', 'only here'))
  const remote = doc(p('a', 'one R'), p('b', 'two'), p('y', 'only there'))
  const m = marker({ base, local, remote, lt: 'Left', rt: 'Right' })
  const diff = diffConflict(m)
  const all = (side) => Object.fromEntries([diff.title, ...diff.rows].map((r) => [r.id, side]))
  const l = applyChoices(m, all('local'), diff)
  const r = applyChoices(m, all('remote'), diff)
  assert.equal(l.content, local)
  assert.equal(r.content, remote)
  assert.equal(l.title, 'Left')
  assert.equal(r.title, 'Right')
  assert.equal(l.side, 'local')
})

test('title is its own row and follows the base', () => {
  const content = doc(p('a', 'x'))
  assert.equal(diffConflict(marker({ base: content, local: content, remote: content, lt: 'New', rt: 'Old', bt: 'Old' })).title.kind, 'local-only')
  assert.equal(diffConflict(marker({ base: content, local: content, remote: content, lt: 'New', rt: 'Other', bt: 'Old' })).title.kind, 'both')
  const m = marker({ base: content, local: doc(p('a', 'x L')), remote: content, lt: 'Old', rt: 'Newer', bt: 'Old' })
  const merged = applyChoices(m, {})
  assert.equal(merged.title, 'Newer')
  assert.deepEqual(texts(merged.content), ['x L'])
})

test('without a base every difference is a choice that defaults to the kept side', () => {
  const local = doc(p('a', 'one L'), p('b', 'two'), p('c', 'local only'))
  const remote = doc(p('a', 'one R'), p('b', 'two'))
  for (const kept of ['local', 'remote']) {
    const m = marker({ local, remote, kept })
    const diff = diffConflict(m)
    assert.equal(diff.hasBase, false)
    assert.deepEqual(diff.rows.map((r) => r.kind), ['both', 'unchanged', 'added'])
    assert.ok(diff.rows.filter((r) => r.options.length).every((r) => r.needsChoice && r.default === kept))
    assert.deepEqual(texts(applyChoices(m, {}).content), kept === 'local' ? ['one L', 'two', 'local only'] : ['one R', 'two'])
  }
})

test('duplicate block ids are told apart by occurrence', () => {
  const base = doc(p('d', 'first'), p('d', 'second'))
  const local = doc(p('d', 'first'), p('d', 'second L'))
  const remote = doc(p('d', 'first R'), p('d', 'second'))
  const diff = diffConflict(marker({ base, local, remote }))
  assert.deepEqual(diff.rows.map((r) => r.kind), ['remote-only', 'local-only'])
  assert.deepEqual(texts(applyChoices(marker({ base, local, remote }), {}).content), ['first R', 'second L'])
})

test('legacy blocks without ids are keyed by content and pair up when changed on both sides', () => {
  const legacy = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const base = doc(legacy('keep'), legacy('edit me'))
  const same = diffConflict(marker({ base, local: doc(legacy('keep'), legacy('edit me')), remote: doc(legacy('keep'), legacy('edit me')) }))
  assert.deepEqual(same.rows.map((r) => r.kind), ['unchanged', 'unchanged'])
  const rows = diffConflict(marker({ base, local: doc(legacy('keep'), legacy('edit me L')), remote: doc(legacy('keep'), legacy('edit me R')) })).rows
  assert.deepEqual(rows.map((r) => r.kind), ['unchanged', 'both'])
  assert.ok(rows[1].tokens.some((t) => t.op === 'del') && rows[1].tokens.some((t) => t.op === 'ins'))
  const oneSided = diffConflict(marker({ base, local: doc(legacy('keep'), legacy('edit me L')), remote: base })).rows
  assert.deepEqual(oneSided.map((r) => r.kind), ['unchanged', 'local-only'])
})

test('reordered blocks keep this device\'s order and lose nothing', () => {
  const base = doc(p('a', 'A'), p('b', 'B'), p('c', 'C'), p('d', 'D'))
  const local = doc(p('a', 'A L'), p('b', 'B'), p('c', 'C'), p('d', 'D'))
  const remote = doc(p('d', 'D'), p('a', 'A'), p('b', 'B'), p('c', 'C R'))
  const m = marker({ base, local, remote })
  const diff = diffConflict(m)
  assert.equal(diff.rows.length, 4)
  assert.equal(diff.rows.filter((r) => r.moved).length, 1)
  assert.deepEqual(texts(applyChoices(m, {}).content), ['A L', 'B', 'C R', 'D'])
  assert.equal(applyChoices(m, Object.fromEntries(diff.rows.map((r) => [r.id, 'remote'])), diff).content, remote)
})

test('delete versus edit needs a choice; a plain delete does not', () => {
  const base = doc(p('a', 'A'), p('b', 'B'), p('c', 'C'))
  const local = doc(p('a', 'A'), p('b', 'B edited'), p('c', 'C'))
  const remote = doc(p('a', 'A'), p('c', 'C'))
  const m = marker({ base, local, remote })
  const row = diffConflict(m).rows[1]
  assert.equal(row.kind, 'delete-vs-edit')
  assert.equal(row.by, 'remote')
  assert.ok(row.needsChoice)
  assert.deepEqual(texts(applyChoices(m, { b1: 'remote' }).content), ['A', 'C'])
  assert.deepEqual(texts(applyChoices(m, { b1: 'local' }).content), ['A', 'B edited', 'C'])
  const plain = diffConflict(marker({ base, local: base, remote })).rows[1]
  assert.deepEqual([plain.kind, plain.needsChoice, plain.default], ['deleted', false, 'remote'])
})

test('additions on both sides at one position can keep both, in order', () => {
  const base = doc(p('a', 'A'), p('z', 'Z'))
  const local = doc(p('a', 'A'), p('l1', 'L1'), p('l2', 'L2'), p('z', 'Z'))
  const remote = doc(p('a', 'A'), p('r1', 'R1'), p('z', 'Z'))
  const m = marker({ base, local, remote })
  const diff = diffConflict(m)
  assert.deepEqual(diff.rows.map((r) => r.kind), ['unchanged', 'added', 'unchanged'])
  assert.deepEqual(diff.rows[1].options, ['local', 'remote', 'both'])
  assert.equal(diff.rows[1].default, 'both')
  assert.deepEqual(texts(applyChoices(m, {}).content), ['A', 'L1', 'L2', 'R1', 'Z'])
  assert.deepEqual(texts(applyChoices(m, { b1: 'remote' }).content), ['A', 'R1', 'Z'])
})

test('Persian text splits into words and diffs word by word', () => {
  const a = 'این یک بند است'
  const b = 'این یک بند کوتاه است'
  assert.equal(wordPieces(a).join(''), a)
  const tokens = diffPieces(wordPieces(a), wordPieces(b))
  assert.equal(tokens.filter((t) => t.op !== 'ins').map((t) => t.text).join(''), a)
  assert.equal(tokens.filter((t) => t.op !== 'del').map((t) => t.text).join(''), b)
  assert.ok(tokens.some((t) => t.op === 'ins' && t.text.includes('کوتاه')))
  const m = marker({ base: doc(p('a', a)), local: doc(p('a', b)), remote: doc(p('a', 'این یک بند است!')) })
  const row = diffConflict(m).rows[0]
  assert.equal(row.kind, 'both')
  assert.equal(row.tokenKind, 'text')
})

test('formatting-only differences are flagged and code diffs by line', () => {
  const bold = { type: 'paragraph', attrs: { blockId: 'a' }, content: [{ type: 'text', text: 'same', marks: [{ type: 'bold' }] }] }
  const row = diffConflict(marker({ local: doc(bold), remote: doc(p('a', 'same')) })).rows[0]
  assert.equal(row.formatOnly, true)
  const code = (text) => ({ type: 'codeBlock', attrs: { blockId: 'c' }, content: [{ type: 'text', text }] })
  const c = diffConflict(marker({ local: doc(code('a\nb\nc')), remote: doc(code('a\nB\nc')) })).rows[0]
  assert.equal(c.tokenKind, 'code')
  assert.deepEqual(c.tokens.map((t) => [t.op, t.text]), [['eq', 'a\n'], ['del', 'b\n'], ['ins', 'B\n'], ['eq', 'c']])
})

test('atomic blocks are chosen whole and keep their original objects', () => {
  const table = (id, cell) => ({ type: 'table', attrs: { blockId: id }, content: [p(null, cell)] })
  const base = doc(table('t', 'x'))
  const local = doc(table('t', 'x L'))
  const m = marker({ base, local, remote: base })
  const row = diffConflict(m).rows[0]
  assert.equal(row.tokens, undefined)
  assert.equal(row.kind, 'local-only')
  assert.equal(applyChoices(m, {}).content, local)
  const mixed = marker({ base: doc(table('t', 'x'), p('a', 'A')), local: doc(table('t', 'x L'), p('a', 'A')), remote: doc(table('t', 'x'), p('a', 'A R')) })
  const merged = applyChoices(mixed, {})
  assert.equal(merged.content.content[0], mixed.local.page.content.content[0])
  assert.equal(merged.content.content[1], mixed.remote.page.content.content[1])
  assert.ok(valid(merged.content))
})

test('non-document content is one all-or-nothing row', () => {
  const m = marker({ local: '<p>a</p>', remote: doc(p('a', 'b')), kept: 'remote' })
  const diff = diffConflict(m)
  assert.equal(diff.rows.length, 1)
  assert.equal(applyChoices(m, { b0: 'local' }, diff).content, '<p>a</p>')
})

test('results are deterministic and the merged page is never empty', () => {
  const base = doc(p('a', 'A'))
  const m = marker({ base, local: doc(p('a', 'A'), p('b', 'B')), remote: doc(p('c', 'C'), p('a', 'A')) })
  assert.equal(canonical(diffConflict(m)), canonical(diffConflict(m)))
  const empty = marker({ base: doc(p('a', 'A')), local: doc(p('a', 'A')), remote: doc(p('a', 'A R')) })
  assert.ok(valid(applyChoices(empty, defaultChoices(diffConflict(empty))).content))
  const gone = marker({ base: doc(p('a', 'A'), p('b', 'B')), local: doc(p('a', 'A'), p('b', 'B')), remote: doc(p('a', 'A')) })
  const removed = marker({ base: doc(p('b', 'B')), local: doc(p('b', 'B')), remote: doc(p('c', 'C')) })
  assert.deepEqual(texts(applyChoices(removed, {}).content), ['C'])
  assert.ok(valid(applyChoices(gone, {}).content))
})

test('a 300-block page is compared quickly', () => {
  const blocks = (edit) => Array.from({ length: 300 }, (_, i) => p('id' + i, `Paragraph number ${i} with some words in it` + (edit(i) ? ' edited' : '')))
  const base = doc(...blocks(() => false))
  const m = marker({ base, local: doc(...blocks((i) => i % 7 === 0)), remote: doc(...blocks((i) => i % 5 === 0)) })
  const start = performance.now()
  const diff = diffConflict(m)
  const merged = applyChoices(m, {}, diff)
  const ms = performance.now() - start
  assert.equal(diff.rows.length, 300)
  assert.equal(merged.content.content.length, 300)
  assert.ok(ms < 500, `took ${ms}ms`)
})
