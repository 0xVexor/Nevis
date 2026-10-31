import { t } from '../i18n'

const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`
let close: (() => void) | null = null

/** The app's dropdown for a DOM-built toolbar (code block language): searchable list, check on the current one, keyboard friendly. */
export function openLangMenu(anchor: HTMLElement, items: { value: string; label: string }[], current: string, onPick: (v: string) => void) {
  close?.()
  const pop = document.createElement('div')
  pop.className = 'ds-pop lang-pop'
  pop.innerHTML = '<div class="lang-head"><input class="lang-search" type="text" spellcheck="false"></div><div class="lang-list" role="listbox"></div>'
  const input = pop.querySelector('input') as HTMLInputElement
  input.placeholder = t('Search languages…')
  const list = pop.querySelector('.lang-list') as HTMLElement
  let shown = items
  let sel = Math.max(0, items.findIndex((i) => i.value === current))

  const draw = () => {
    list.innerHTML = ''
    if (!shown.length) {
      const none = document.createElement('div')
      none.className = 'lang-none'
      none.textContent = t('No language found')
      list.append(none)
      return
    }
    shown.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'option')
      b.className = 'ds-menu-item' + (it.value === current ? ' on' : '') + (i === sel ? ' hot' : '')
      b.innerHTML = '<span class="ds-menu-label"></span>' + (it.value === current ? `<span class="sel-check">${CHECK}</span>` : '')
      ;(b.querySelector('.ds-menu-label') as HTMLElement).textContent = it.label
      b.onmousedown = (e) => e.preventDefault()
      b.onclick = () => pick(it.value)
      b.onmousemove = () => {
        if (sel !== i) {
          sel = i
          list.querySelector('.hot')?.classList.remove('hot')
          b.classList.add('hot')
        }
      }
      list.append(b)
    })
    list.querySelector('.hot')?.scrollIntoView({ block: 'nearest' })
  }
  const pick = (v: string) => {
    shut()
    onPick(v)
  }
  const outside = (e: MouseEvent) => !pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node) && shut()
  const shut = () => {
    document.removeEventListener('mousedown', outside, true)
    pop.remove()
    close = null
  }
  close = shut

  input.oninput = () => {
    const q = input.value.trim().toLowerCase()
    shown = q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q)) : items
    sel = 0
    draw()
  }
  input.onkeydown = (e) => {
    if (e.key === 'Escape') return (e.preventDefault(), shut())
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (shown.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
      return draw()
    }
    if (e.key === 'Enter' && shown[sel]) (e.preventDefault(), pick(shown[sel].value))
  }

  document.body.append(pop)
  draw()
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  pop.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  pop.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`
  document.addEventListener('mousedown', outside, true)
  input.focus()
}
