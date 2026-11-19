import type { ReactNode } from 'react'
import { Icon } from '../design-system'
import { isTauri } from '../db'
import { SYNC_ENABLED } from '../releaseFeatures'
export type SettingsTab = 'appearance' | 'editor' | 'language' | 'general' | 'data' | 'sync' | 'database' | 'shortcuts' | 'connections' | 'about'
const ALL_TABS: { id: SettingsTab; label: string; title: string; hint: string; icon: ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', title: 'Appearance', hint: 'Colors, background, glass and the shape of the app.', icon: <Icon name="palette" size={16} /> },
  { id: 'editor', label: 'Editor & font', title: 'Editor & font', hint: 'The typeface, size and color of your page text.', icon: <Icon name="type" size={16} /> },
  { id: 'language', label: 'Language', title: 'Language & layout', hint: 'The interface language and which side things sit on.', icon: <Icon name="globe" size={16} /> },
  { id: 'general', label: 'General', title: 'General', hint: 'Reminders and how files are stored.', icon: <Icon name="settings" size={16} /> },
  { id: 'data', label: 'Data & backup', title: 'Data & backup', hint: 'Import, export and back up your notes.', icon: <Icon name="file-archive" size={16} /> },
  { id: 'sync', label: 'Sync', title: 'Sync', hint: 'Keep your workspaces the same on all your devices.', icon: <Icon name="cloud" size={16} /> },
  { id: 'database', label: 'Database', title: 'Database', hint: 'Calendar defaults, maps and connected services.', icon: <Icon name="table" size={16} /> },
  { id: 'connections', label: 'AI connection', title: 'AI connection', hint: 'Let an AI app work with your documents.', icon: <Icon name="globe" size={16} /> },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', hint: 'Everything you can do without leaving the keyboard.', icon: <Icon name="keyboard" size={16} /> },
  { id: 'about', label: 'About', title: 'About', hint: 'What this app is.', icon: <Icon name="info" size={16} /> },
]

/** Sync is a desktop feature, and a release can leave it out. */
export const SETTINGS_TABS = ALL_TABS.filter(tab => tab.id !== 'sync' || (SYNC_ENABLED && isTauri))
