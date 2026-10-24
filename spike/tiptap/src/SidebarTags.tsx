import { useState } from 'react'
import type { Page } from './repo'
import { PageIcon } from './PageIcon'
import * as Ic from './icons'
import { t } from './i18n'

export interface TagInfo {
  key: string
  label: string
  count: number
}

const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const VISIBLE = 10

/** Sidebar tag browser: a wrap of colour-tinted chips (most used first); picking one lists the pages that carry it right below. */
export function SidebarTags({ tags, active, onPick, shut, onToggle, pages, currentId, onOpen }: {
  tags: TagInfo[]
  active: string | null
  onPick: (key: string | null) => void
  shut: boolean
  onToggle: () => void
  pages: Page[]
  currentId?: string
  onOpen: (id: string) => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? tags : tags.slice(0, VISIBLE)
  // the picked tag stays visible even when it is beyond the first rows
  const pick = tags.find((g) => g.key === active)
  const list = pick && !shown.includes(pick) ? [...shown, pick] : shown
  return (
    <>
      <button className={'section' + (shut ? ' shut' : '')} onClick={onToggle}>
        {t('Tags')}<span className="section-n">{tags.length}</span><Ic.Chevron size={13} />
      </button>
      {!shut && (
        <div className="tagbox">
          <div className="tagcloud">
            {list.map((g) => (
              <button
                key={g.key}
                className={'tagchip' + (active === g.key ? ' on' : '')}
                style={{ ['--hue' as string]: hueOf(g.label) } as React.CSSProperties}
                aria-pressed={active === g.key}
                onClick={() => onPick(active === g.key ? null : g.key)}
              >
                <span className="tagchip-h">#</span>
                <span className="tagchip-t" dir="auto">{g.label}</span>
                <span className="tagchip-n">{g.count}</span>
              </button>
            ))}
            {tags.length > VISIBLE && (
              <button className="tagchip more" onClick={() => setAll((v) => !v)}>
                {all ? t('Show less') : t('{n} more', { n: tags.length - VISIBLE })}
              </button>
            )}
          </div>

          {pick && (
            <div className="tagres">
              <div className="tagres-head">
                <span>{t('Pages tagged')} <b dir="auto">#{pick.label}</b></span>
                <button title={t('Clear filter')} onClick={() => onPick(null)}><Ic.Close size={13} /></button>
              </div>
              {pages.map((p) => (
                <div key={p.id} className={'row' + (p.id === currentId ? ' cur' : '')} onClick={() => onOpen(p.id)}>
                  <span className="ic"><PageIcon page={p} /></span>
                  <span className="ntitle" dir="auto">{p.title || t('Untitled')}</span>
                </div>
              ))}
              {pages.length === 0 && <div className="empty-note">{t('No pages yet')}</div>}
            </div>
          )}
        </div>
      )}
    </>
  )
}
