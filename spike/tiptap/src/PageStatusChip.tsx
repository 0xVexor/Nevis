import { ChipButton, Icon, useMenu, type MenuItem } from './design-system'
import { STATUS } from './meta'
import type { PageStatus } from './repo'
import { t } from './i18n'

/** A page's status as a chip that opens the status menu (click or right-click). Shared by the page header and the pages table. */
export function PageStatusChip({ status, onChange, disabled }: { status: PageStatus | undefined; onChange: (next: PageStatus | undefined) => void; disabled?: boolean }) {
  const { open, menu } = useMenu()
  const items: MenuItem[] = [
    { label: 'No status', checked: !status, onSelect: () => onChange(undefined) },
    ...(Object.keys(STATUS) as PageStatus[]).map((s) => ({ label: STATUS[s].label, swatch: STATUS[s].color, checked: status === s, onSelect: () => onChange(s) })),
  ]
  const name = t(status ? STATUS[status].label : 'No status')
  return (
    <>
      <ChipButton
        empty={!status}
        aria-haspopup="menu"
        aria-label={t('Status') + ': ' + name}
        disabled={disabled}
        icon={status && <i className="ds-menu-dot" style={{ background: STATUS[status].color }} />}
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
