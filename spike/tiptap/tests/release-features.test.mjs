import test from 'node:test'
import assert from 'node:assert/strict'
import { SLIDES_ENABLED, APPEARANCE_PRESETS_ENABLED, pageAvailableInRelease } from '../src/releaseFeatures.ts'
import { appearancePresets, workspaceAppearance } from '../src/appearancePresets.ts'
import { createPortraitDeck } from '../src/decks/model.ts'
import { decodeDeck, encodeDeck } from '../src/decks/storage.ts'

test('named presets fall back without removing definitions or rewriting saved choices', () => {
  assert.equal(APPEARANCE_PRESETS_ENABLED,false)
  const saved={appearancePreset:'forest-lime'}
  assert.equal(workspaceAppearance(saved.appearancePreset),'calm')
  assert.equal(saved.appearancePreset,'forest-lime')
  assert.ok(appearancePresets.some(preset=>preset.id==='forest-lime'))
})
test('existing deck content survives serialization while hidden from release navigation', () => {
  let id=0
  assert.equal(SLIDES_ENABLED,false)
  const original=createPortraitDeck(()=>String(++id))
  const stored=encodeDeck(original)
  assert.equal(pageAvailableInRelease({kind:'deck'}),false)
  assert.equal(pageAvailableInRelease({kind:'page'}),true)
  assert.deepEqual(decodeDeck(stored),original)
})
