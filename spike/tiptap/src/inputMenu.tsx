import { shortcutLabel } from './shortcuts'
import { Icon, Menu, type MenuItem } from './design-system'
import { createRoot, type Root } from 'react-dom/client'
import { t } from './i18n'

type Field = HTMLInputElement | HTMLTextAreaElement
const TEXT_TYPES = ['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']

let root: Root | null = null
let host: HTMLElement | null = null
const close = () => root?.render(null)

function FieldMenu({ el, at }: { el: Field; at: DOMRect }) {
  const hasSel = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0)
  const editable = !el.readOnly && !el.disabled
  const sel = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
  // the editor's text menu and this one are the same shared Menu: edit commands with their shortcuts, then Search
  const run = (f: () => void) => () => (el.focus(), f())
  const items: MenuItem[] = [
    { label: 'Cut', icon: <Icon name="scissors" size={16} />, hint: shortcutLabel(['Mod', 'X']), disabled: !hasSel || !editable, onSelect: run(() => document.execCommand('cut')) },
    { label: 'Copy', icon: <Icon name="copy" size={16} />, hint: shortcutLabel(['Mod', 'C']), disabled: !hasSel, onSelect: run(() => document.execCommand('copy')) },
    {
      label: 'Paste',
      icon: <Icon name="clipboard" size={16} />,
      hint: shortcutLabel(['Mod', 'V']),
      disabled: !editable,
      onSelect: run(() => void navigator.clipboard?.readText().then((s) => s && document.execCommand('insertText', false, s)).catch(() => {})),
    },
    { label: 'Select all', icon: <Icon name="select-all" size={16} />, hint: shortcutLabel(['Mod', 'A']), onSelect: run(() => el.select()) },
    ...(hasSel
      ? [
          { kind: 'sep' as const },
          { label: t('Search for “{text}”', { text: sel.slice(0, 20) }), raw: true, icon: <Icon name="search" size={16} />, onSelect: run(() => window.dispatchEvent(new CustomEvent('open-search', { detail: sel }))) },
        ]
      : []),
  ]
  return <Menu anchor={at} items={items} onClose={close} />
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
