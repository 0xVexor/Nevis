import { useEffect, useState } from 'react'
import { useLabels } from './labels'
import { useSettings, getSettings, updateSettings } from '../settings'
import { bindingKeys, chordOf, pauseBindings, usableChord } from '../shortcutBindings'
import { SHORTCUTS, keyLabel, shortcutKeys } from '../shortcuts'
import { isRemappable } from '../shortcutCommands'
import { Button } from '../design-system/Button'
import { Field } from '../design-system/controls'
import { SettingGroup } from './parts'
export function ShortcutsSettings() {
  const l = useLabels(), s = useSettings()
  const [query, setQuery] = useState(''), [recording, setRecording] = useState<string | null>(null), [error, setError] = useState('')
  const commandId = (item: { binding?: string; label: string }) => item.binding ?? 'study:' + item.label
  useEffect(() => {
    if (!recording) return
    const resume = pauseBindings()
    const handle = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Escape') { setRecording(null); setError(''); return }
      const chord = chordOf(event); if (!chord) return
      if (!usableChord(chord)) { setError(l('Use Ctrl or Alt with the key, or a function key.')); return }
      const settings = getSettings()
      const conflict = SHORTCUTS.flatMap(g => g.items).some(item => {
        const id = commandId(item)
        const alternatives = settings.shortcuts[id] ? [settings.shortcuts[id]] : item.binding ? [bindingKeys(item.binding)] : shortcutKeys(item)
        return id !== recording && alternatives.some(keys => keys.join('+') === chord.join('+'))
      })
      if (conflict) { setError(l('This shortcut is already assigned.')); return }
      updateSettings({ shortcuts: { ...settings.shortcuts, [recording]: chord } }); setRecording(null); setError('')
    }
    window.addEventListener('keydown', handle, true)
    return () => { resume(); window.removeEventListener('keydown', handle, true) }
  }, [recording, l])
  const groups = SHORTCUTS.map(group => ({ ...group, items: group.items.filter(item => (l(item.label) + ' ' + item.label + ' ' + (s.shortcuts[commandId(item)] ? [s.shortcuts[commandId(item)]] : item.binding ? [bindingKeys(item.binding)] : shortcutKeys(item)).map(keys => keys.map(keyLabel).join('+')).join(' ')).toLowerCase().includes(query.toLowerCase())) })).filter(group => group.items.length)
  return <>
    <p className="prefs-caption">{l('Editor actions and app commands can be changed here. Shortcuts marked Built in are fixed and always work with their own keys.')}</p>
    <label className="prefs-field prefs-shortcut-search"><span>{l('Find a shortcut')}</span><Field type="search" placeholder={l('Search shortcuts')} value={query} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="alert" className="prefs-error">{error}</p>}
    {groups.map(group => <SettingGroup key={group.title} title={l(group.title)}>{group.items.map(item => {
      const id = commandId(item), keys = s.shortcuts[id] ? [s.shortcuts[id]] : item.binding ? [bindingKeys(item.binding)] : shortcutKeys(item)
      return <div key={id} className="prefs-shortcut-row"><span>{l(item.label)}</span><div>{recording === id ? <kbd>{l('Press the new keys.')}</kbd> : keys.map((chord, i) => <span className="prefs-key-chord" key={i} dir="ltr">{chord.map(key => <kbd key={key}>{keyLabel(key)}</kbd>)}</span>)}{!isRemappable(item) ? <span className="prefs-fixed">{l('Built in')}</span> : <><Button size="sm" variant="ghost" aria-label={l('Change') + ': ' + l(item.label)} onClick={() => { setError(''); setRecording(recording === id ? null : id) }}>{l(recording === id ? 'Cancel' : 'Change')}</Button>{s.shortcuts[id] && <Button size="sm" variant="ghost" onClick={() => { const next = { ...s.shortcuts }; delete next[id]; updateSettings({ shortcuts: next }); setRecording(null) }}>{l('Reset')}</Button>}</>}</div></div>
    })}</SettingGroup>)}
    {!groups.length && <p className="prefs-caption">{l('No shortcut matches.')}</p>}
    <p className="prefs-caption">{l('Press Escape to cancel recording. Reset restores the default binding.')}</p>
  </>
}
