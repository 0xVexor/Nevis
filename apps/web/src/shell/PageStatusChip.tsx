import { ChipButton, Icon, useMenu, type MenuItem } from '../ds'
import { STATUS } from './meta'
import type { PageStatus } from './model'
import { t } from '../i18n'

/** A page's status as a chip that opens the status menu (click or right-click). Shared by the page header and the pages table. */
export function PageStatusChip({ status, onChange, disabled }: { status: PageStatus | undefined; onChange: (next: PageStatus | undefined) => void; disabled?: boolean }) {
  const { open, menu } = useMenu()
  const knownStatus = status && Object.hasOwn(STATUS, status) ? status : undefined
  const items: MenuItem[] = [
    { label: 'No status', checked: !knownStatus, onSelect: () => onChange(undefined) },
    ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ label: STATUS[s].label, swatch: STATUS[s].color, checked: knownStatus === s, onSelect: () => onChange(s) })),
  ]
  const name = t(knownStatus ? STATUS[knownStatus].label : 'No status')
  return (
    <>
      <ChipButton
        empty={!knownStatus}
        aria-haspopup="menu"
        aria-label={t('Status') + ': ' + name}
        disabled={disabled}
        icon={knownStatus && <i className="ds-menu-dot" style={{ background: STATUS[knownStatus].color }} />}
        onClick={(e) => (e.stopPropagation(), open(items, e.currentTarget))}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), !disabled && open(items, e))}
      >
        <span>{name}</span>
        <Icon name="chevron-down" size={14} />
      </ChipButton>
      {menu}
    </>
  )
}
