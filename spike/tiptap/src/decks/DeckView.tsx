import { useEffect, useRef, useState } from 'react'
import { EditorContent, getSchema, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Button } from '../design-system'
import type { DocNode } from '../docNode'
import { contentProblem } from '../editor/contentSafety'
import { CodeBlock } from '../editor/codeBlock'
import { HeadingDir } from '../editor/headingDir'
import { t } from '../i18n'
import type { Page } from '../repo'
import { repo } from '../store'
import { addSlide, moveSlide } from './model'
import type { Deck } from './model'
import { decodeDeck, encodeDeck } from './storage'
import './decks.css'

const extensions = [StarterKit.configure({ codeBlock: false }), CodeBlock, HeadingDir]
const schema = getSchema(extensions)

function SlideEditor({ content, readOnly, onEdit }: { content: DocNode; readOnly: boolean; onEdit: (previous: DocNode, next: DocNode) => boolean }) {
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

  return <EditorContent className="deck-slide-content" editor={editor} />
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
        {deck.slides.map(({ id }, i) => (
          <Button key={id} size="sm" variant={i === index ? 'primary' : 'default'} aria-pressed={i === index} onClick={() => setSelected(id)}>
            {t('Slide {n}', { n: i + 1 })}
          </Button>
        ))}
        {!readOnly && (
          <>
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
      <div className="deck-slide" style={{ aspectRatio: `${deck.size.width} / ${deck.size.height}` }}>
        {issue ? (
          <p role="alert">{t(issue)}</p>
        ) : (
          <SlideEditor
            key={slide.id}
            content={slide.content}
            readOnly={readOnly}
            onEdit={(previous, content) =>
              update((current) => {
                if (current.slides.find(({ id }) => id === slide.id)?.content !== previous) throw new Error('Slide content changed')
                return { ...current, slides: current.slides.map((item) => (item.id === slide.id ? { ...item, content } : item)) }
              })
            }
          />
        )}
      </div>
    </section>
  )
}
