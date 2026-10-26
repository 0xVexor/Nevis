import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '../../../spike/tiptap/src/database/fixtures.ts'

// Regression: adding the required property replaces the configuration object inside createProperty.
// A freshly created layout must still retain the property it uses to render.
for (const [type, key, kind] of [
  ['board', 'groupPropertyId', 'status'],
  ['calendar', 'datePropertyId', 'date'],
  ['timeline', 'datePropertyId', 'date'],
  ['map', 'placePropertyId', 'place'],
]) {
  test('new ' + type + ' keeps its automatically created property and can reuse it', async () => {
    const h = createHarness()
    const db = await h.one('database.create', { title: 'Layout setup' })
    const created = await h.one('view.create', { containerId: db.containerId, sourceId: db.sourceId, type, name: type })
    const v = h.state.get('view', created.viewId)
    const required = h.state.prop(v.configuration[key])
    assert.ok(required, 'the new view must reference its required property')
    assert.equal(required.kind, kind)
    assert.ok(v.configuration.visibleProperties.includes(required.id))
    const again = await h.one('view.create', { containerId: db.containerId, sourceId: db.sourceId, type, name: type + ' copy' })
    assert.equal(h.state.get('view', again.viewId).configuration[key], required.id)
    assert.equal(h.state.props(db.sourceId).filter((p) => p.kind === kind).length, 1)
  })
}
