// Captures GOLDEN FIXTURES: the V1 update bytes (Yjs `encodeStateAsUpdate`) of a document and its projection, under the schema of
// the CURRENT `SV`. Run ONCE per schema version:  npx tsx scripts/capture-golden.ts
// Files are written with the "do not overwrite" flag: a stored fixture is never regenerated, by this script or by a test. A test
// checks each file against its recorded SHA-256, so a silent rewrite fails. docs/formats/golden-fixtures.md says what they assert.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { SV } from '@nevis/protocol'
import { BODY, normalize, project, schema } from '../src'
import { fixtures } from '../test/fixtures'

const dir = join(import.meta.dirname, '..', 'fixtures', `sv${SV}`)
mkdirSync(dir, { recursive: true })
for (const [name, json] of Object.entries(fixtures)) {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(schema, normalize(json), doc.getXmlFragment(BODY))
  const update = Y.encodeStateAsUpdate(doc)
  const rec = { name, sv: SV, update: Buffer.from(update).toString('base64'), sha256: createHash('sha256').update(update).digest('hex'), projection: project(doc) }
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec, null, 1) + '\n', { flag: 'wx' })
  console.log('captured', name, update.length, 'bytes')
}
