import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { addSlide, createPortraitDeck, deckStyle, moveSlide } from '../src/decks/model.ts'
import { deckFromTemplate, deckTemplates } from '../src/decks/templates.ts'
import { decodeDeck, encodeDeck } from '../src/decks/storage.ts'

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

test('templates create independent decks and keep their accent, components, and slide sizes on save', () => {
  for (const template of deckTemplates) {
    const first = deckFromTemplate(template, (value) => value, randomUUID)
    const second = deckFromTemplate(template, (value) => value, randomUUID)
    assert.equal(first.slides.length, template.sections.length)
    assert.ok(first.slides.every((slide) => second.slides.every(({ id }) => id !== slide.id)))
    const customized = { ...first, accent: '#49621e', components: [{ id: randomUUID(), name: 'Finding', emphasis: true }] }
    assert.deepEqual(decodeDeck(encodeDeck(customized)), customized)
  }
})

test('previously saved decks without styling data still open', () => {
  const deck = createPortraitDeck(randomUUID)
  const saved = encodeDeck(deck)
  saved.attrs.format = 1
  assert.deepEqual(decodeDeck(saved), deck)
})

test('Forest & Lime saves distinct cover and teaching colors', () => {
  const deck = deckFromTemplate(deckTemplates[0], (value) => value, randomUUID)
  const reopened = decodeDeck(encodeDeck(deck))
  assert.deepEqual(reopened, deck)
  assert.equal(deckStyle(reopened, reopened.slides[0])['--deck-paper'], '#183a30')
  assert.equal(deckStyle(reopened, reopened.slides[0])['--deck-accent'], '#c7e875')
  assert.equal(deckStyle(reopened, reopened.slides[1])['--deck-paper'], '#f1f4ec')
  assert.equal(deckStyle(reopened, reopened.slides[1])['--deck-accent'], '#49621e')
})
