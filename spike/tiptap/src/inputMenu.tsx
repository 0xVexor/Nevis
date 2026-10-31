import { shortcutLabel } from './shortcuts'
import { createRoot, type Root } from 'react-dom/client'
import { MenuItem, MenuSep, Popover } from './ui'
import * as Ic from './icons'
import { t } from './i18n'

type Field = HTMLInputElement | HTMLTextAreaElement
const TEXT_TYPES = ['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']

let root: Root | null = null
let host: HTMLElement | null = null
const close = () => root?.render(null)

function FieldMenu({ el, at }: { el: Field; at: DOMRect }) {
  const hasSel = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0)
  const editable = !el.readOnly && !el.disabled
  const run = (f: () => void) => () => (close(), el.focus(), f())
  return (
    <Popover anchor={at} onClose={close}>
      <div className="ds-menu ctx-menu">
        <div className="menu-quick">
          <button title={t('Cut') + '  ' + shortcutLabel(['Mod', 'X'])} disabled={!hasSel || !editable} onClick={run(() => document.execCommand('cut'))}><Ic.Cut size={16} /></button>
          <button title={t('Copy') + '  ' + shortcutLabel(['Mod', 'C'])} disabled={!hasSel} onClick={run(() => document.execCommand('copy'))}><Ic.Copy size={16} /></button>
          <button
            title={t('Paste') + '  ' + shortcutLabel(['Mod', 'V'])}
            disabled={!editable}
            onClick={run(() => void navigator.clipboard?.readText().then((s) => s && document.execCommand('insertText', false, s)).catch(() => {}))}
          >
            <Ic.Paste size={16} />
          </button>
        </div>
        <MenuItem icon={<Ic.SelectAll />} label={t('Select all')} hint="Ctrl+A" onClick={run(() => el.select())} />
        {hasSel && <MenuSep />}
        {hasSel && <MenuItem icon={<Ic.Search />} label={t('Search for “{text}”', { text: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).slice(0, 20) })} onClick={run(() => window.dispatchEvent(new CustomEvent('open-search', { detail: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) })))} />}
      </div>
    </Popover>
  )
}

/** Right-click in a text field (page title, tag box, search, dialogs) opens the app's own menu instead of the browser's. */
export function initInputMenu() {
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as HTMLElement).closest?.('input, textarea') as Field | null
    if (!el || (el instanceof HTMLInputElement && !TEXT_TYPES.includes(el.type))) return
    e.preventDefault()
    if (!host) {
      host = document.createElement('div')
      host.id = 'input-menu-root'
      document.body.appendChild(host)
      root = createRoot(host)
    }
    root!.render(<FieldMenu el={el} at={new DOMRect(e.clientX, e.clientY, 0, 0)} />)
  })
}
