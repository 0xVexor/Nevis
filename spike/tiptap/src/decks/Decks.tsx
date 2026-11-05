import { Button, Icon, Row, Screen } from '../design-system'
import { t } from '../i18n'
import type { Page } from '../repo'
import { decodeDeck } from './storage'

export function Decks({ pages, onOpen, onNew, onTemplates }: { pages: Page[]; onOpen: (id: string) => void; onNew: () => void; onTemplates: () => void }) {
  const decks = pages.filter((page) => page.kind === 'deck').sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <Screen
      width="wide"
      title={t('Slide decks')}
      actions={
        <>
          <Button onClick={onTemplates}>{t('Deck templates')}</Button>
          <Button variant="primary" onClick={onNew}>
            {t('New deck')}
          </Button>
        </>
      }
    >
      {decks.length ? (
        <div className="ds-list ds-list--framed">
          {decks.map((page) => {
            const deck = decodeDeck(page.content)
            return (
              <Row
                as="button"
                key={page.id}
                icon={<Icon name="layers" />}
                text={page.title || t('Untitled deck')}
                trailing={deck ? t('{n} slides', { n: deck.slides.length }) : undefined}
                onClick={() => onOpen(page.id)}
              />
            )
          })}
        </div>
      ) : (
        <div className="ds-empty ds-empty--framed">
          <Icon name="layers" />
          <b>{t('No decks yet')}</b>
        </div>
      )}
    </Screen>
  )
}
