import { Switch } from '../ds/controls'
import { Icon } from '../ds/icons'
import { useSettings, updateSettings } from '../deviceSettings'

import { PreferenceRow as SettingRow, SegmentedChoice } from '../ds/Preferences'
export { PreferenceRow as SettingRow, PreferenceGroup as SettingGroup, RangeControl as Range } from '../ds/Preferences'

export function Toggle({ label, hint, setting }: { label: string; hint?: string; setting: 'showCovers' | 'showIcons' | 'reduceMotion' | 'cardReminders' | 'compressImages' | 'prereleaseUpdates' }) {
  const s = useSettings()
  return <SettingRow label={label} hint={hint}><Switch checked={s[setting]} label={label} onChange={next => updateSettings({ [setting]: next })} /></SettingRow>
}

export function Choice<V extends string>({ items, ...props }: { label: string; value: V; items: { value: V; label: string; icon?: string }[]; onChange: (value: V) => void }) {
 return <SegmentedChoice {...props} items={items.map(item => ({...item, icon: item.icon ? <Icon name={item.icon} /> : undefined}))} />
}
