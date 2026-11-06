import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Button, Dropdown, Icon } from '../design-system'
import { deckThemes } from '../appearancePresets'
import { promptDialog } from '../dialog'
import type { DocNode } from '../docNode'
import { t } from '../i18n'
import type { Page } from '../repo'
import { repo } from '../store'
import { addSlide, deckStyle, moveSlide } from './model'
import type { Deck, Slide } from './model'
import { decodeDeck, encodeDeck } from './storage'
import { printDeck } from './printDeck'
import { SlashCommand } from '../editor/slash'
import { ImageFiles } from '../editor/image'
import { CommandPalette, closeCommandPalette, openCommandPalette } from '../editor/commandPalette'
import { slideActions, slideCommands } from './slideCommands'
import './decks.css'

import { slideContentProblem, slideExtensions } from './slideRendering'

function SlideEditor({
  pageId,
  deck,
  slide,
  readOnly,
  onEdit,
  onLibraryChange,
}: {
  pageId: string
  deck: Deck
  slide: Slide
  readOnly: boolean
  onEdit: (previous: DocNode, next: DocNode) => boolean
  onLibraryChange: (change: (deck: Deck) => Deck) => boolean
}) {
  const { content } = slide
  const displayed = useRef(content)
  const extra = useMemo(
    () => (active: import('@tiptap/core').Editor) => slideActions(active, decodeDeck(repo.get(pageId)?.content)?.components),
    [pageId],
  )
  const editingExtensions = useMemo(
    () => [...slideExtensions, ImageFiles, SlashCommand.configure({ allowedCommands: slideCommands, extraCommands: extra }), CommandPalette.configure({ allowedCommands: slideCommands, extraCommands: extra })],
    [extra],
  )
  const editor = useEditor({
    extensions: editingExtensions,
    content,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const next = editor.getJSON() as DocNode
      if (onEdit(displayed.current, next)) displayed.current = next
      else editor.commands.setContent(displayed.current, { emitUpdate: false })
    },
  })

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!readOnly, false)
    if (displayed.current !== content) {
      displayed.current = content
      editor.commands.setContent(content, { emitUpdate: false })
    }
  }, [content, editor, readOnly])

  useEffect(
    () => () => {
      if (editor) closeCommandPalette(editor)
    },
    [editor],
  )

  return (
    <>
      {!readOnly && editor && (
        <div className="deck-actions" role="group" aria-label={t('Slide layout')}>
          <Button size="sm" icon={<Icon name="plus" size={16} />} onClick={() => openCommandPalette(editor, slideCommands, extra)}>
            {t('Slide commands')}
          </Button>
          <Button
            size="sm"
            disabled={(deck.components?.length ?? 0) >= 50}
            onClick={async () => {
              const name = (await promptDialog({ title: t('New component'), message: t('Component name') }))?.trim().slice(0, 80)
              if (name) onLibraryChange((current) => ({ ...current, components: [...(current.components ?? []), { id: crypto.randomUUID(), name, emphasis: true }] }))
            }}
          >
            {t('New component')}
          </Button>
          {deck.components?.map(({ id, name, emphasis }) => (
            <Button
              key={id}
              size="sm"
              aria-pressed={emphasis}
              onClick={() =>
                onLibraryChange((current) => ({
                  ...current,
                  components: current.components?.map((component) => (component.id === id ? { ...component, emphasis: !component.emphasis } : component)),
                }))
              }
            >
              {t('Use accent for {name}', { name })}
            </Button>
          ))}
        </div>
      )}
      <div className="deck-slide" style={{ aspectRatio: `${deck.size.width} / ${deck.size.height}`, ...deckStyle(deck, slide) } as CSSProperties}>
        <EditorContent className="deck-slide-content" editor={editor} />
      </div>
    </>
  )
}

export function DeckView({ page, readOnly, onChange, onError }: { page: Page; readOnly: boolean; onChange: () => void; onError: (message: string) => void }) {
  const [selected, setSelected] = useState<string>()
  const deck = decodeDeck(page.content)
  if (!deck) return <p className="deck-view">{t('This deck contains unsupported or damaged content.')}</p>
  const index = Math.max(
    0,
    deck.slides.findIndex((slide) => slide.id === selected),
  )
  const slide = deck.slides[index]

  const update = (change: (current: Deck) => Deck) => {
    const latest = decodeDeck(repo.get(page.id)?.content)
    if (!latest || readOnly) return false
    try {
      const next = change(latest)
      repo.update(page.id, { content: encodeDeck(next) })
      onChange()
      return true
    } catch {
      onChange()
      onError(t('Could not save the slide change.'))
      return false
    }
  }

  const move = (offset: -1 | 1) =>
    update((current) => {
      const at = current.slides.findIndex(({ id }) => id === slide.id)
      if (at < 0 || at + offset < 0 || at + offset >= current.slides.length) throw new RangeError('Slide position changed')
      return moveSlide(current, slide.id, current.slides[at + (offset < 0 ? -1 : 2)]?.id ?? null)
    })

  const issue = slideContentProblem(slide.content)
  return (
    <section className="deck-view" aria-label={page.title || t('Untitled deck')}>
      <h1 dir="auto">{page.title || t('Untitled deck')}</h1>
      <div className="deck-actions" role="group" aria-label={t('Slides')}>
        <Button
          size="sm"
          onClick={() =>
            void printDeck(page.title, deck).catch((error) =>
              onError(error instanceof RangeError ? t('Slide {n} does not fit on a PDF page.', { n: Number(error.message) }) : t('Could not print the deck.')),
            )
          }
        >
          {t('Print deck / Save as PDF')}
        </Button>
        {deck.slides.map(({ id }, i) => (
          <Button key={id} size="sm" variant={i === index ? 'primary' : 'default'} aria-pressed={i === index} onClick={() => setSelected(id)}>
            {t('Slide {n}', { n: i + 1 })}
          </Button>
        ))}
        {!readOnly && (
          <>
            <Dropdown
              label="Deck theme"
              value={deck.theme ?? 'calm-light'}
              options={deckThemes.map(({ id, label }) => ({ value: id, label }))}
              onChange={(theme) => update((current) => ({ ...current, theme, accent: undefined }))}
            />
            <label className="deck-accent">
              {t('Deck accent')} <input type="color" value={deckStyle(deck, slide)['--deck-accent']} onChange={(event) => update((current) => ({ ...current, accent: event.target.value }))} />
            </label>
            <Button
              size="sm"
              onClick={() =>
                update((current) => {
                  const next = addSlide(current, () => crypto.randomUUID())
                  setSelected(next.slides.at(-1)?.id)
                  return next
                })
              }
            >
              {t('Add slide')}
            </Button>
            <Button size="sm" disabled={index === 0} onClick={() => move(-1)}>
              {t('Move slide earlier')}
            </Button>
            <Button size="sm" disabled={index === deck.slides.length - 1} onClick={() => move(1)}>
              {t('Move slide later')}
            </Button>
          </>
        )}
      </div>
      {issue ? (
        <p role="alert">{t(issue)}</p>
      ) : (
        <SlideEditor
          key={slide.id}
          pageId={page.id}
          deck={deck}
          slide={slide}
          readOnly={readOnly}
          onLibraryChange={update}
          onEdit={(previous, content) =>
            update((current) => {
              if (current.slides.find(({ id }) => id === slide.id)?.content !== previous) throw new Error('Slide content changed')
              return { ...current, slides: current.slides.map((item) => (item.id === slide.id ? { ...item, content } : item)) }
            })
          }
        />
      )}
    </section>
  )
}
