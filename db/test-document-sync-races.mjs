import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentService } from '../spike/tiptap/src/documents/service.ts'
import { MemoryDocumentStorage } from '../spike/tiptap/src/documents/memoryStorage.ts'
import { canonicalDocumentValue } from '../spike/tiptap/src/documents/revision.ts'

// A page that another device deleted for good while it is open here: the desktop store refuses it with
// `SYNC:permanently_deleted` (and still writes the rest of the batch). The edit must not be dropped, and must not wedge saving.

class NativeLike extends MemoryDocumentStorage {
  dead = new Set()
  async save(write) {
    // like save_pages_checked: the preconditions of the whole batch first
    const disk = new Map((await this.load()).map((p) => [p.id, p]))
    for (const [id, expected] of Object.entries(write.expectedPages ?? {})) {
      if (canonicalDocumentValue(disk.get(id) ?? null) !== canonicalDocumentValue(expected)) throw new Error('Document revision conflict')
    }
    const refused = write.upserts.filter((p) => this.dead.has(p.id)).map((p) => p.id)
    if (!refused.length) return super.save(write)
    await super.save({ ...write, upserts: write.upserts.filter((p) => !this.dead.has(p.id)) })
    throw new Error(`SYNC:permanently_deleted\nids=${refused.join(',')}\nkept=`)
  }
}

function host() {
  let next = 0, clock = 1800000000000
  const tasks = new Set()
  const events = [], errors = [], notices = []
  return {
    events, errors, tasks, notices,
    now: () => ++clock, createId: () => `page-${++next}`,
    defer(task) { tasks.add(task); return () => tasks.delete(task) },
    emit: (event, detail) => events.push({ event, detail }),
    report: (context, error) => errors.push({ context, error }),
    recoveredTitle: (title) => `Recovered: ${title}`,
    recovered: (info) => notices.push(info),
  }
}

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const textOf = (page) => page?.content?.content?.[0]?.content?.[0]?.text

async function open() {
  const storage = new NativeLike('purged-edit')
  const h = host()
  const service = new DocumentService({ storage, host: h })
  await service.init()
  const page = service.create(null)
  service.update(page.id, { title: 'Doomed', content: doc('first') })
  const other = service.create(null)
  service.update(other.id, { title: 'Other' })
  await service.flushBeforeUpdate()
  return { storage, h, service, page, other }
}

async function purgeElsewhere(storage, page) {
  const disk = (await storage.load()).find((p) => p.id === page.id)
  await storage.save({ upserts: [], removed: [page.id], replaceAll: false, baseVersions: {}, expectedPages: { [page.id]: disk } })
  storage.dead.add(page.id)
}

test('an edit of a page that was purged elsewhere is saved as a new page and the rest of the batch is saved too', async () => {
  const { storage, h, service, page, other } = await open()
  await purgeElsewhere(storage, page)
  service.update(page.id, { content: doc('typed after the purge') })
  service.update(other.id, { title: 'Other, edited' })
  await service.flushBeforeUpdate()
  const rows = await storage.load()
  assert.equal(rows.find((p) => p.id === other.id).title, 'Other, edited', 'the other page of the batch is saved')
  assert.ok(!rows.some((p) => p.id === page.id), 'the purged page is not brought back')
  const copy = rows.find((p) => p.title === 'Recovered: Doomed')
  assert.ok(copy && copy.id !== page.id, 'the edit lives on as a new page')
  assert.equal(textOf(copy), 'typed after the purge')
  assert.ok((await storage.listVersions(copy.id)).some((v) => textOf(v) === 'typed after the purge'), 'a version is kept')
  assert.deepEqual(h.notices, [{ fromId: page.id, toId: copy.id, title: 'Doomed' }], 'the person is told')
  assert.equal(service.get(page.id), undefined)
  assert.equal(textOf(service.get(copy.id)), 'typed after the purge')
  // saving is not wedged: the next batch goes through
  service.update(other.id, { title: 'Other, again' })
  await service.flushBeforeUpdate()
  assert.equal((await storage.load()).find((p) => p.id === other.id).title, 'Other, again')
  assert.ok(!h.errors.some((e) => e.context === 'storage'), JSON.stringify(h.errors))
})

test('a page the person deleted here for good is not brought back by a refused save', async () => {
  const { storage, h, service, page } = await open()
  service.update(page.id, { content: doc('typed, then deleted for good') })
  service.purge(page.id)
  storage.dead.add(page.id)
  await service.flushBeforeUpdate()
  const rows = await storage.load()
  assert.ok(!rows.some((p) => p.id === page.id || p.title.startsWith('Recovered')), 'neither the page nor a copy exists')
  assert.deepEqual(h.notices, [])
})

test('a version from a device whose clock runs a day fast does not win the conflict against a correct edit here', async () => {
  const { storage, service, page } = await open()
  const disk = (await storage.load()).find((p) => p.id === page.id)
  const fast = 1_800_000_000_000 + 86_400_000 // a day ahead of the test host clock
  await storage.save({ upserts: [{ ...disk, content: doc('from the fast phone'), updatedAt: fast }], removed: [], replaceAll: false, baseVersions: {} })
  service.update(page.id, { content: doc('typed here') })
  await service.flushBeforeUpdate()
  assert.equal(textOf((await storage.load()).find((p) => p.id === page.id)), 'typed here')
  assert.ok((await storage.listVersions(page.id)).some((v) => textOf(v) === 'from the fast phone'), 'the other version is kept')
})
