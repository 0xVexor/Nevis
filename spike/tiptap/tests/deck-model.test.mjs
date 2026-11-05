import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { addSlide, createPortraitDeck, moveSlide } from '../src/decks/model.ts'

test('slide IDs still target the same content after slides are reordered', () => {
  const deck = addSlide(addSlide(createPortraitDeck(randomUUID), randomUUID), randomUUID)
  const [cover, example, closing] = deck.slides
  assert.equal(new Set(deck.slides.map(({ id }) => id)).size, 3)

  const moved = moveSlide(deck, closing.id, example.id)
  assert.deepEqual(moved.slides, [cover, closing, example])
  assert.deepEqual(moveSlide(moved, cover.id, null).slides, [closing, example, cover])
  assert.deepEqual(deck.slides, [cover, example, closing])
})

test('a missing destination cannot silently move a slide to the end', () => {
  const deck = createPortraitDeck(randomUUID)
  assert.throws(() => moveSlide(deck, deck.slides[0].id, 'missing'), /Destination slide does not exist/)
  assert.throws(() => moveSlide(deck, 'missing', null), /Slide to move does not exist/)
})
