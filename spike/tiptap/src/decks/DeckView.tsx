import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { EditorContent, generateHTML, getSchema, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Button } from '../design-system'
import { promptDialog } from '../dialog'
import type { DocNode } from '../docNode'
import { contentProblem } from '../editor/contentSafety'
import { CodeBlock } from '../editor/codeBlock'
import { HeadingDir } from '../editor/headingDir'
import { LayoutColumn, LayoutGroup, LayoutSafety } from '../editor/layout'
import { t } from '../i18n'
import type { Page } from '../repo'
import { repo } from '../store'
import { addSlide, calloutComponent, deckStyle, defaultDeckAccent, moveSlide } from './model'
import type { Deck } from './model'
import { decodeDeck, encodeDeck } from './storage'
import { printDeck } from './printDeck'
import { DeckComponentNode } from './componentNode'
import './decks.css'

const extensions = [StarterKit.configure({ codeBlock: false }), CodeBlock, HeadingDir, LayoutGroup, LayoutColumn, LayoutSafety, DeckComponentNode]
const schema = getSchema(extensions)

function SlideEditor({
  deck,
  content,
  readOnly,
  onEdit,
  onLibraryChange,
}: {
  deck: Deck
  content: DocNode
  readOnly: boolean
  onEdit: (previous: DocNode, next: DocNode) => boolean
  onLibraryChange: (change: (deck: Deck) => Deck) => boolean
}) {
  const displayed = useRef(content)
  const editor = useEditor({
    extensions,
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

  return (
    <>
      {!readOnly && editor && (
        <div className="deck-actions" role="group" aria-label={t('Slide layout')}>
          {[1, 2, 3].map((count) => (
            <Button
              key={count}
              size="sm"
              onClick={() => {
                if (editor.commands.setLayoutColumns(count)) editor.commands.focus()
                else if (count > 1) editor.chain().focus().insertLayout(count).run()
              }}
            >
              {count === 1 ? t('Stack columns') : t('{n} columns', { n: count })}
            </Button>
          ))}
          <Button size="sm" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
            {t('Code block')}
          </Button>
          {[calloutComponent, ...(deck.components ?? [])].map(({ id, name }) => (
            <Button
              key={id}
              size="sm"
              onClick={() =>
                editor
                  .chain()
                  .focus()
                  .insertContent({ type: 'deckComponent', attrs: { componentId: id }, content: [{ type: 'paragraph' }] })
                  .run()
              }
            >
              {id === calloutComponent.id ? t(name) : name}
            </Button>
          ))}
          <Button
            size="sm"
            onClick={() => {
              if (editor.isActive('deckComponent')) {
                const variant = editor.getAttributes('deckComponent').variant === 'compact' ? 'regular' : 'compact'
                editor.chain().focus().updateAttributes('deckComponent', { variant }).run()
              }
            }}
          >
            {t('Switch component variant')}
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
      <div className="deck-slide" style={{ aspectRatio: `${deck.size.width} / ${deck.size.height}`, ...deckStyle(deck) } as CSSProperties}>
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

  const issue = contentProblem(slide.content, schema)
  return (
    <section className="deck-view" aria-label={page.title || t('Untitled deck')}>
      <h1 dir="auto">{page.title || t('Untitled deck')}</h1>
      <div className="deck-actions" role="group" aria-label={t('Slides')}>
        <Button
          size="sm"
          onClick={() =>
            void printDeck(page.title, deck, (content) => {
              if (contentProblem(content, schema)) throw new Error('Unsupported slide content')
              return generateHTML(content, extensions)
            }).catch((error) => onError(error instanceof RangeError ? t('Slide {n} does not fit on a PDF page.', { n: Number(error.message) }) : t('Could not print the deck.')))
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
            <label className="deck-accent">
              {t('Deck accent')} <input type="color" value={deck.accent ?? defaultDeckAccent} onChange={(event) => update((current) => ({ ...current, accent: event.target.value }))} />
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
          deck={deck}
          content={slide.content}
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
