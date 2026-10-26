// Shared UI pieces of the database feature: hooks, kind icons / labels, colored chips, small helpers.
import { useEffect, useSyncExternalStore, useState, type ReactNode } from 'react'
import type { Definition, Id, Kind } from '../model/types.ts'
import type { OptionColor } from '../props/config.ts'
import { getDatabase, peekDatabase } from '../runtime'
import type { DatabaseService } from '../service.ts'
import { t } from '../../i18n'

/** The database service of the open vault (null until it finished opening). Re-renders on every committed change. */
export function useDb(): DatabaseService | null {
  const [svc, setSvc] = useState<DatabaseService | null>(peekDatabase())
  useEffect(() => {
    let live = true
    if (!svc) void getDatabase().then((s) => live && setSvc(s)).catch((e) => console.error('database', e))
    return () => void (live = false)
  }, [svc])
  useSyncExternalStore(svc ? svc.subscribe : noSubscribe, svc ? svc.getVersion : zero)
  return svc
}
const noSubscribe = () => () => {}
const zero = () => 0

/** Re-render when page titles / bodies change in the legacy repo (rows show their titles live). */
export function useRepoTick(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const f = () => setN((x) => x + 1)
    window.addEventListener('data-changed', f)
    window.addEventListener('external-change', f)
    return () => {
      window.removeEventListener('data-changed', f)
      window.removeEventListener('external-change', f)
    }
  }, [])
  return n
}

export const KIND_LABEL: Record<Kind, string> = {
  title: 'Title', text: 'Text', number: 'Number', select: 'Select', multi_select: 'Multi-select', status: 'Status', date: 'Date', people: 'People',
  files: 'Files & media', checkbox: 'Checkbox', url: 'URL', email: 'Email', phone: 'Phone', relation: 'Relation', rollup: 'Rollup', formula: 'Formula',
  created_time: 'Created time', created_by: 'Created by', last_edited_time: 'Last edited time', last_edited_by: 'Last edited by', button: 'Button',
  unique_id: 'ID', place: 'Place', verification: 'Verification', connected: 'Connected',
}

/** Kinds offered in the "new property" picker (Title exists once; Connected needs a provider and is offered in Connections). */
export const PICKABLE_KINDS: Kind[] = [
  'text', 'number', 'select', 'multi_select', 'status', 'date', 'people', 'files', 'checkbox', 'url', 'email', 'phone', 'relation', 'rollup', 'formula',
  'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'button', 'unique_id', 'place', 'verification', 'connected',
]

const P = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICON_PATHS: Record<Kind, string> = {
  title: 'M5 7V5h14v2M12 5v14M9 19h6',
  text: 'M4 6h16M4 12h16M4 18h10',
  number: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  select: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 11l4 4 4-4',
  multi_select: 'M4 7h9M4 12h9M4 17h9M17 6l2 2 3-3M17 16l2 2 3-3',
  status: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v4l3 2',
  date: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  people: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 6 18.500V20M11 11.500a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7z',
  files: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  checkbox: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 12l3 3 5-6',
  url: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  email: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3 7l9 6 9-6',
  phone: 'M6 3h4l2 5-2.500 1.500a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z',
  relation: 'M7 17 17 7M9 7h8v8',
  rollup: 'M4 6h16M4 12h10M4 18h6M17 14v6M14 17h6',
  formula: 'M18 5H7l5 7-5 7h11',
  created_time: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  created_by: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0',
  last_edited_time: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  last_edited_by: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0',
  button: 'M5 9h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2zM9 12h6',
  unique_id: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  place: 'M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  verification: 'M12 3 4 6v6c0 4.500 3.400 8 8 9 4.600-1 8-4.500 8-9V6zM9 12l2 2 4-4',
  connected: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
}
export const KindIcon = ({ kind }: { kind: Kind }) => (
  <span className="db-kind" title={t(KIND_LABEL[kind])}>
    <P d={ICON_PATHS[kind]} />
  </span>
)

export const COLOR_CLASS = (c: OptionColor | string | undefined) => 'dbc-' + (c || 'default')
export const OPTION_COLOR_LIST: OptionColor[] = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']

export const Chip = ({ color, children, title, onRemove, muted }: { color?: string; children: ReactNode; title?: string; onRemove?: () => void; muted?: boolean }) => (
  <span className={'db-chip ' + COLOR_CLASS(color) + (muted ? ' muted' : '')} title={title}>
    <span className="db-chip-t" dir="auto">{children}</span>
    {onRemove && (
      <button type="button" className="db-chip-x" aria-label={t('Remove')} onClick={(e) => (e.stopPropagation(), onRemove())}>
        ×
      </button>
    )}
  </span>
)

/** Human text of an error from a command. Codes are stable; messages are shown as they are. */
export function errorText(code: string, message: string): string {
  switch (code) {
    case 'REVISION_CONFLICT': return t('Someone changed this meanwhile. Reload and try again.')
    case 'ACCESS_DENIED': return t('You do not have access to do this.')
    case 'READ_ONLY': return t('This value comes from a connected service; change it there.')
    case 'QUOTA': return t('Storage limit reached: {m}', { m: message })
    case 'RECOVERY_REQUIRED': return t('The database needs repair before it can be edited.')
    default: return message
  }
}

export const defOf = (svc: DatabaseService, id: Id): Definition | undefined => svc.state.prop(id)

/** Safe link opener: only http(s), mailto, tel. */
export function openSafe(url: string) {
  if (!/^(https?:|mailto:|tel:)/i.test(url.trim())) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function plainTitle(title: string | undefined) {
  return title && title.trim() ? title : t('Untitled')
}
