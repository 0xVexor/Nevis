// Shared UI pieces of the database feature: hooks, kind icons and labels, option chips, small helpers.
import { useEffect, useSyncExternalStore, useState, type CSSProperties, type ReactNode } from 'react'
import type { Kind } from '../model/types.ts'
import type { OptionColor } from '../props/config.ts'
import { getDatabase, peekDatabase } from '../runtime'
import type { DatabaseService } from '../service.ts'
import { Icon, Notice } from '../../design-system'
import { t } from '../../i18n'

/** The database service of the open vault (null until it finished opening). Re-renders on every committed change. */
export function useDb(): DatabaseService | null {
  const [svc, setSvc] = useState<DatabaseService | null>(peekDatabase())
  useEffect(() => {
    let live = true
    if (!svc)
      void getDatabase()
        .then((s) => live && setSvc(s))
        .catch((e) => console.error('database', e))
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
  title: 'Title',
  text: 'Text',
  number: 'Number',
  select: 'Select',
  multi_select: 'Multi-select',
  status: 'Status',
  date: 'Date',
  people: 'People',
  files: 'Files & media',
  checkbox: 'Checkbox',
  url: 'URL',
  email: 'Email',
  phone: 'Phone',
  relation: 'Relation',
  rollup: 'Rollup',
  formula: 'Formula',
  created_time: 'Created time',
  created_by: 'Created by',
  last_edited_time: 'Last edited time',
  last_edited_by: 'Last edited by',
  button: 'Button',
  unique_id: 'ID',
  place: 'Place',
  verification: 'Verification',
  connected: 'Connected',
}

/** Kinds offered in the "new property" picker, grouped the way people look for them (Title exists once). */
export const KIND_GROUPS: { label: string; kinds: Kind[] }[] = [
  { label: 'Basic', kinds: ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'people', 'files'] },
  { label: 'Links and contact', kinds: ['url', 'email', 'phone', 'place', 'relation'] },
  { label: 'Calculated', kinds: ['rollup', 'formula', 'unique_id', 'button', 'verification'] },
  { label: 'Set by the app', kinds: ['created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'connected'] },
]

/** One design-system icon per property kind, so a kind looks the same in headers, menus and the row panel. */
const KIND_ICON: Record<Kind, string> = {
  title: 'type',
  text: 'align-left',
  number: 'hash',
  select: 'chevrons-up-down',
  multi_select: 'list',
  status: 'target',
  date: 'calendar',
  people: 'user',
  files: 'paperclip',
  checkbox: 'checklist',
  url: 'link',
  email: 'inbox',
  phone: 'bell',
  relation: 'relation',
  rollup: 'sigma',
  formula: 'formula',
  created_time: 'history',
  created_by: 'users',
  last_edited_time: 'history',
  last_edited_by: 'users',
  button: 'pointer',
  unique_id: 'key',
  place: 'map',
  verification: 'shield',
  connected: 'plug',
}
export const kindIcon = (kind: Kind) => KIND_ICON[kind]
export const KindIcon = ({ kind, size = 15 }: { kind: Kind; size?: number }) => (
  <span className="dv-kind" title={t(KIND_LABEL[kind])}>
    <Icon name={KIND_ICON[kind]} size={size} />
  </span>
)

export const OPTION_COLOR_LIST: OptionColor[] = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
export const COLOR_LABEL: Record<OptionColor, string> = {
  default: 'Default',
  gray: 'Gray',
  brown: 'Brown',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
}
/** The colour of an option as a CSS value (the tokens live in tokens.css). */
export const optionColor = (c: OptionColor | string | undefined) => `var(--ds-opt-${c && (OPTION_COLOR_LIST as string[]).includes(c) ? c : 'default'})`

/** An option, a person or a linked item shown as a value: the design system's chip, tinted by the option's colour. */
export const Chip = ({ color, children, title, onRemove, muted }: { color?: string; children: ReactNode; title?: string; onRemove?: () => void; muted?: boolean }) => (
  <span className="ds-chip dv-chip" data-muted={muted || undefined} title={title} style={{ '--c': optionColor(color) } as CSSProperties}>
    <span className="dv-chip-t" dir="auto">
      {children}
    </span>
    {onRemove && (
      <button type="button" className="dv-chip-x" aria-label={t('Remove')} onClick={(e) => (e.stopPropagation(), onRemove())}>
        <Icon name="x" size={12} />
      </button>
    )}
  </span>
)

/** A short message where a whole view would be: what is missing and what to do. */
export function ViewMessage({ title, children, action, tone }: { title: string; children?: ReactNode; action?: ReactNode; tone?: 'bad' }) {
  return (
    <div className="ds-empty ds-empty--framed dv-message" role={tone === 'bad' ? 'alert' : undefined}>
      <b>{title}</b>
      {children && <span>{children}</span>}
      {action}
    </div>
  )
}

/** An error line under a field or in a panel. */
export const ErrorLine = ({ children }: { children: ReactNode }) => (
  <Notice tone="bad" compact className="dv-error">{children}</Notice>
)

/** A quiet hint line. */
export const Hint = ({ children }: { children: ReactNode }) => <p className="dv-hint">{children}</p>

/** Human text of an error from a command. Codes are stable; messages are shown as they are. */
export function errorText(code: string, message: string): string {
  switch (code) {
    case 'REVISION_CONFLICT':
      return t('Someone changed this meanwhile. Reload and try again.')
    case 'ACCESS_DENIED':
      return t('You do not have access to do this.')
    case 'READ_ONLY':
      return t('This value comes from a connected service; change it there.')
    case 'QUOTA':
      return t('Storage limit reached: {m}', { m: message })
    case 'RECOVERY_REQUIRED':
      return t('The database needs repair before it can be edited.')
    default:
      return message
  }
}

/** Safe link opener: only http(s), mailto, tel. */
export function openSafe(url: string) {
  if (!/^(https?:|mailto:|tel:)/i.test(url.trim())) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function plainTitle(title: string | undefined) {
  return title && title.trim() ? title : t('Untitled')
}

/** Options of a Dropdown built from user records (property, view, source names): shown as typed, never translated. */
export const rawOptions = <T extends { id: string; name: string }>(list: T[]) => list.map((x) => ({ value: x.id, label: x.name || t('Untitled'), raw: true }))
