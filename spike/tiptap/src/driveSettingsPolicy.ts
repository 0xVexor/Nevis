export type SettingScope = 'global' | 'device-local'
export const driveSettingKeys = ['lang', 'dir', 'theme', 'accent', 'bg', 'radius', 'font', 'fontSize', 'textColor', 'sidebar', 'pagesView', 'sideGlass', 'mainGlass', 'bgStrength', 'showCovers', 'showIcons', 'cardReminders', 'compressImages', 'reduceMotion', 'prereleaseUpdates'] as const
export type SettingsPolicy = Partial<Record<(typeof driveSettingKeys)[number], SettingScope>>
export function settingsPolicy(record: unknown): SettingsPolicy {
  const policy = (record as { nevisDriveSyncPolicy?: { schemaVersion?: number; fields?: Record<string, unknown> } } | undefined)?.nevisDriveSyncPolicy
  if (!policy) return {}
  if (policy.schemaVersion !== 1 || !policy.fields || typeof policy.fields !== 'object') throw new Error('DRIVE:settings_policy_schema')
  for (const [key, value] of Object.entries(policy.fields)) if (!driveSettingKeys.includes(key as (typeof driveSettingKeys)[number]) || (value !== 'global' && value !== 'device-local')) throw new Error('DRIVE:settings_policy_invalid')
  return policy.fields as SettingsPolicy
}
/** Preserve this installation's controls when a newly downloaded Vault omits device-local values. */
export function preserveDeviceSettings(remote: string, current: string, policy: SettingsPolicy): string {
  if (!Object.values(policy).includes('device-local')) return remote
  const incoming: Record<string, unknown> = JSON.parse(remote), local: Record<string, unknown> = JSON.parse(current)
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || !local || typeof local !== 'object' || Array.isArray(local)) throw new Error('DRIVE:settings_invalid')
  for (const [key, scope] of Object.entries(policy)) if (scope === 'device-local') {
    if (Object.hasOwn(local, key)) incoming[key] = local[key]
    else delete incoming[key]
  }
  return JSON.stringify(incoming)
}

export const driveSettingLabels: Record<(typeof driveSettingKeys)[number], string> = { lang: 'Language', dir: 'Text direction', theme: 'Theme', accent: 'Accent color', bg: 'Background', radius: 'Corner radius', font: 'Font', fontSize: 'Font size', textColor: 'Text color', sidebar: 'Sidebar', pagesView: 'Page view', sideGlass: 'Sidebar transparency', mainGlass: 'Content transparency', bgStrength: 'Background strength', showCovers: 'Show covers', showIcons: 'Show icons', cardReminders: 'Card reminders', compressImages: 'Compress images', reduceMotion: 'Reduce motion', prereleaseUpdates: 'Preview updates' }
