import { ICON_PREFIX, parseIcon } from '../iconSet'
import { IconPicker } from './IconPicker'

/** A page or inline icon: the IconPicker, reading and writing the stored form `i:name` or `i:name@#rrggbb`. */
export function PageIconPicker({ onPick, onClear, current, clearLabel }: { onPick: (icon: string, close?: boolean) => void; onClear: () => void; current?: string; clearLabel?: string }) {
  const cur = current && current.startsWith(ICON_PREFIX) ? parseIcon(current) : null
  return <IconPicker name={cur?.name} color={cur?.color} clearLabel={clearLabel} onClear={onClear} onPick={(name, color, close) => onPick(ICON_PREFIX + name + (color ? '@' + color : ''), close)} />
}
