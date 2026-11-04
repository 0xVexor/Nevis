import { Switch } from '../design-system/controls'
import { Icon } from '../design-system/icons'
import { useSettings, updateSettings } from '../settings'

import { PreferenceRow as SettingRow, SegmentedChoice } from '../design-system/Preferences'
export { PreferenceRow as SettingRow, PreferenceGroup as SettingGroup, RangeControl as Range } from '../design-system/Preferences'

export function Toggle({ label, hint, setting }: { label: string; hint?: string; setting: 'showCovers' | 'showIcons' | 'reduceMotion' | 'cardReminders' | 'compressImages' | 'prereleaseUpdates' }) {
  const s = useSettings()
  return <SettingRow label={label} hint={hint}><Switch checked={s[setting]} label={label} onChange={next => updateSettings({ [setting]: next })} /></SettingRow>
}

export function Choice<V extends string>({ items, ...props }: { label: string; value: V; items: { value: V; label: string; icon?: string }[]; onChange: (value: V) => void }) {
 return <SegmentedChoice {...props} items={items.map(item => ({...item, icon: item.icon ? <Icon name={item.icon} /> : undefined}))} />
}
