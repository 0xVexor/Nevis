import { t } from '../i18n'
import { ICON_PREFIX, iconSvg } from './menuIcons'
/** Shared popup list for Suggestion-based menus (/ commands, [[ page links). */
/** The part of TipTap's suggestion props the menu reads (the command palette calls it with just these). */
interface MenuProps<T> {
  items: T[]
  command: (item: T) => void
  clientRect?: (() => DOMRect | null) | null
}
interface MenuKeyProps {
  event: KeyboardEvent
}

interface MenuView {
  icon: string
  title: string
  desc: string
  disabled?: boolean
  group?: string
}

/** `preview` returns trusted SVG markup (see slashPreview.ts) for the highlighted item, drawn in a small frame beside the menu. */
export function menuRender<T>(cfg: { label: string | (() => string); view: (i: T) => MenuView; empty?: string; preview?: (i: T) => string | null }) {
  return () => {
    let el: HTMLDivElement | null = null
    let pv: HTMLDivElement | null = null
    let items: T[] = []
    let selected = 0
    let cmd: ((i: T) => void) | null = null

    const dropPreview = () => {
      pv?.remove()
      pv = null
    }
    /** The frame sits on the menu's inline-end side, or the other side when there is no room; on a very narrow screen it is left out. */
    const drawPreview = () => {
      const art = items[selected] !== undefined ? cfg.preview?.(items[selected]) : null
      if (!el || !art) return dropPreview()
      if (!pv) {
        pv = document.createElement('div')
        pv.className = 'slash-preview'
        document.body.append(pv)
      }
      pv.innerHTML = art
      const r = el.getBoundingClientRect()
      const w = pv.offsetWidth
      const rtl = getComputedStyle(el).direction === 'rtl'
      const fits = (x: number) => x >= 8 && x + w <= window.innerWidth - 8
      const first = rtl ? r.left - w - 8 : r.right + 8
      const second = rtl ? r.right + 8 : r.left - w - 8
      const x = fits(first) ? first : fits(second) ? second : null
      if (x === null) return dropPreview()
      pv.style.left = `${x}px`
      pv.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - pv.offsetHeight - 8))}px`
    }

    const draw = () => {
      if (!el) return
      const kept = el.querySelector('.ds-menu-list')?.scrollTop ?? 0
      el.innerHTML = ''
      const label = document.createElement('div')
      label.className = 'ds-menu-head'
      label.textContent = typeof cfg.label === 'function' ? cfg.label() : cfg.label
      el.append(label)
      if (!items.length) {
        const none = document.createElement('div')
        none.className = 'ds-menu-empty'
        none.textContent = cfg.empty ?? t('No items found')
        el.append(none)
        return
      }
      const list = document.createElement('div')
      list.className = 'ds-menu-list'
      el.append(list)
      let group: string | undefined
      items.forEach((it, i) => {
        const v = cfg.view(it)
        if (v.group && v.group !== group) {
          const heading = document.createElement('div')
          heading.className = 'ds-menu-head'
          heading.setAttribute('role', 'presentation')
          heading.textContent = t(v.group)
          list.append(heading)
        }
        group = v.group
        const b = document.createElement('button')
        b.disabled = !!v.disabled
        b.type = 'button'
        b.setAttribute('role', 'menuitem')
        b.className = 'ds-menu-item' + (i === selected ? ' hot' : '')
        b.innerHTML = '<span class="ds-menu-ic"></span><span class="ds-menu-label"><b></b><small></small></span>'
        const ic = b.querySelector('.ds-menu-ic') as HTMLElement
        if (v.icon.startsWith(ICON_PREFIX)) ic.innerHTML = iconSvg(v.icon.slice(ICON_PREFIX.length))
        else ic.textContent = v.icon
        const name = b.querySelector('b') as HTMLElement
        name.textContent = v.title
        name.setAttribute('dir', 'auto')
        ;(b.querySelector('small') as HTMLElement).textContent = v.desc
        b.onmousedown = (e) => {
          e.preventDefault()
          if (!v.disabled) cmd?.(it)
        }
        b.onmousemove = () => {
          if (selected !== i) {
            selected = i
            list.querySelector('.hot')?.classList.remove('hot')
            b.classList.add('hot')
            drawPreview()
          }
        }
        list.append(b)
      })
      const foot = document.createElement('div')
      foot.className = 'ds-menu-foot'
      foot.innerHTML = '<span><kbd class="ds-kbd">↑</kbd><kbd class="ds-kbd">↓</kbd> ' + t('Navigate') + '</span><span><kbd class="ds-kbd">↵</kbd> ' + t('Select') + '</span><span><kbd class="ds-kbd">Esc</kbd> ' + t('Close') + '</span>'
      el.append(foot)
      // keep the scroll position across redraws, then make sure the selected row is fully inside the visible list (never under the footer)
      list.scrollTop = kept
      const cur = list.querySelector<HTMLElement>('.hot')
      if (cur) {
        if (cur.offsetTop - 6 < list.scrollTop) list.scrollTop = Math.max(0, cur.offsetTop - 6)
        else if (cur.offsetTop + cur.offsetHeight + 6 > list.scrollTop + list.clientHeight) list.scrollTop = cur.offsetTop + cur.offsetHeight + 6 - list.clientHeight
      }
    }
    const show = (props: MenuProps<T>) => {
      draw()
      place(props)
      drawPreview()
    }
    const place = (props: MenuProps<T>) => {
      const r = props.clientRect?.()
      if (!el || !r) return
      const h = Math.min(el.offsetHeight || 400, 400)
      const below = r.bottom + 6 + h < window.innerHeight
      el.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`
      el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`
    }

    return {
      onStart: (props: MenuProps<T>) => {
        el = document.createElement('div')
        el.className = 'ds-pop ds-menu ds-menu--command slash-menu'
        el.setAttribute('role', 'menu')
        document.body.append(el)
        items = props.items
        selected = Math.max(
          0,
          items.findIndex((item) => !cfg.view(item).disabled),
        )
        cmd = (i) => props.command(i)
        show(props)
      },
      onUpdate: (props: MenuProps<T>) => {
        items = props.items
        selected = Math.max(
          0,
          items.findIndex((item) => !cfg.view(item).disabled),
        )
        cmd = (i) => props.command(i)
        show(props)
      },
      onKeyDown: ({ event }: MenuKeyProps) => {
        if (!items.length) return false
        const move = (d: number) => {
          for (let n = 0; n < items.length; n++) {
            selected = (selected + d + items.length) % items.length
            if (!cfg.view(items[selected]).disabled) break
          }
          draw()
          drawPreview()
          return true
        }
        if (event.key === 'ArrowDown') return move(1)
        if (event.key === 'ArrowUp') return move(-1)
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!cfg.view(items[selected]).disabled) cmd?.(items[selected])
          return true
        }
        return false
      },
      onExit: () => {
        dropPreview()
        el?.remove()
        el = null
      },
    }
  }
}
