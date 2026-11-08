import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeFa } from '../spike/tiptap/src/normalize.ts'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/agent-documents/${name}.json`, import.meta.url), 'utf8'))
const pages = fixture('pages')
const manifest = fixture('manifest')
const byId = new Map(pages.map((page) => [page.id, page]))
const at = (pageId, path) => path.reduce((node, index) => node.content[index], byId.get(pageId).content)
function* nodes(node) {
  yield node
  for (const child of node.content ?? []) yield* nodes(child)
}
const text = (node) => [...nodes(node)].map((child) => child.text ?? '').join('')

test('synthetic pages have unique identities and valid hierarchy and link targets', () => {
  assert.equal(pages.length, manifest.pageCount)
  assert.equal(byId.size, pages.length)
  for (const page of pages) {
    assert.match(page.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(page.content.type, 'doc')
    assert.ok(page.parentId === null || byId.has(page.parentId))
    const ancestors = new Set([page.id])
    let parent = page.parentId
    while (parent !== null) {
      assert.ok(!ancestors.has(parent), 'fixture hierarchy must not cycle')
      ancestors.add(parent)
      parent = byId.get(parent).parentId
    }
    for (const node of nodes(page.content)) {
      if (node.type === 'pageLink') assert.ok(byId.has(node.attrs.id))
    }
  }
})

test('workflow targets resolve to exact revision-bound source content', () => {
  const targets = new Set(manifest.targets.map((target) => target.name))
  for (const target of manifest.targets) {
    const node = at(target.pageId, target.path)
    assert.equal(node.type, target.type, target.name)
    if ('text' in target) assert.equal(text(node), target.text, target.name)
    if ('attribute' in target) assert.deepEqual(node.attrs[target.attribute], target.value, target.name)
  }
  for (const workflow of manifest.workflows) {
    assert.ok(byId.has(workflow.pageId))
    if (workflow.target) assert.ok(targets.has(workflow.target))
  }
})

test('corpus retains long, ambiguous, rich, unsupported and excluded cases', () => {
  const long = byId.get(manifest.longDocument.pageId)
  assert.ok(long.content.content.filter((node) => node.type === 'heading').length >= manifest.longDocument.minimumSections)
  const all = pages.flatMap((page) => [...nodes(page.content)])
  for (const type of ['table', 'tableCell', 'codeBlock', 'mathInline', 'mathBlock', 'mermaid', 'toggle', 'callout', 'futureWidget']) {
    assert.ok(all.some((node) => node.type === type), `missing ${type}`)
  }
  assert.ok(all.some((node) => node.attrs?.colspan === 2))
  assert.ok(all.some((node) => node.attrs?.dir === 'rtl'))
  assert.ok(all.some((node) => node.attrs?.dir === 'ltr'))
  assert.ok(all.some((node) => node.marks?.some((mark) => mark.type === 'bold')))
  assert.ok(pages.some((page) => [...nodes(page.content)].filter((node) => node.type === 'heading' && text(node) === 'Example').length >= 2))
  for (const id of manifest.excludedPageIds) assert.ok(byId.has(id))
  for (const id of manifest.deletedPageIds) assert.ok(byId.get(id).deletedAt !== null)
})

for (const { input, expected } of manifest.normalizationCases) {
  test(`existing Persian normalization: ${JSON.stringify(input)}`, () => {
    assert.equal(normalizeFa(input), expected)
    assert.equal(normalizeFa(expected), expected)
  })
}
