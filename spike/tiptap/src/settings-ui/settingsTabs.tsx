import type { ReactNode } from 'react'
import * as Ic from '../icons'
export type SettingsTab = 'appearance' | 'editor' | 'language' | 'general' | 'data' | 'database' | 'shortcuts' | 'connections' | 'about'
export const SETTINGS_TABS: { id: SettingsTab; label: string; title: string; hint: string; icon: ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', title: 'Appearance', hint: 'Colors, background, glass and the shape of the app.', icon: <Ic.Palette /> },
  { id: 'editor', label: 'Editor & font', title: 'Editor & font', hint: 'The typeface, size and color of your page text.', icon: <Ic.Type /> },
  { id: 'language', label: 'Language', title: 'Language & layout', hint: 'The interface language and which side things sit on.', icon: <Ic.Globe /> },
  { id: 'general', label: 'General', title: 'General', hint: 'Reminders and how files are stored.', icon: <Ic.Settings /> },
  { id: 'data', label: 'Data & backup', title: 'Data & backup', hint: 'Import, export and back up your notes.', icon: <Ic.Archive /> },
  { id: 'database', label: 'Database', title: 'Database', hint: 'Calendar defaults, maps and connected services.', icon: <Ic.Table /> },
  { id: 'connections', label: 'AI connection', title: 'AI connection', hint: 'Let an AI app work with your documents.', icon: <Ic.Globe /> },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard shortcuts', hint: 'Everything you can do without leaving the keyboard.', icon: <Ic.Keyboard /> },
  { id: 'about', label: 'About', title: 'About', hint: 'What this app is.', icon: <Ic.Info /> },
]

