import { t } from '../i18n'
import { ICON_PREFIX, iconSvg } from './menuIcons'
/** Shared popup list for Suggestion-based menus (/ commands, [[ page links). */
interface MenuView {
  icon: string
  title: string
  desc: string
}

export function menuRender<T>(cfg: { label: string | (() => string); view: (i: T) => MenuView; empty?: string }) {
  return () => {
    let el: HTMLDivElement | null = null
    let items: T[] = []
    let selected = 0
    let cmd: ((i: T) => void) | null = null

    const draw = () => {
      if (!el) return
      const kept = el.querySelector('.slash-list')?.scrollTop ?? 0
      el.innerHTML = ''
      const label = document.createElement('div')
      label.className = 'slash-label'
      label.textContent = typeof cfg.label === 'function' ? cfg.label() : cfg.label
      el.append(label)
      if (!items.length) {
        const none = document.createElement('div')
        none.className = 'slash-empty'
        none.textContent = cfg.empty ?? t('No items found')
        el.append(none)
        return
      }
      const list = document.createElement('div')
      list.className = 'slash-list'
      el.append(list)
      items.forEach((it, i) => {
        const v = cfg.view(it)
        const b = document.createElement('button')
        b.className = 'slash-item' + (i === selected ? ' sel' : '')
        b.innerHTML = '<span class="slash-ic"></span><span class="slash-tx"><b></b><small></small></span>'
        ;const ic = b.querySelector('.slash-ic') as HTMLElement
        if (v.icon.startsWith(ICON_PREFIX)) ic.innerHTML = iconSvg(v.icon.slice(ICON_PREFIX.length))
        else ic.textContent = v.icon
        const t = b.querySelector('b') as HTMLElement
        t.textContent = v.title
        t.setAttribute('dir', 'auto')
        ;(b.querySelector('small') as HTMLElement).textContent = v.desc
        b.onmousedown = (e) => {
          e.preventDefault()
          cmd?.(it)
        }
        b.onmousemove = () => {
          if (selected !== i) {
            selected = i
            list.querySelector('.sel')?.classList.remove('sel')
            b.classList.add('sel')
          }
        }
        list.append(b)
      })
      const foot = document.createElement('div')
      foot.className = 'slash-foot'
      foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> ' + t('Navigate') + '</span><span><kbd>↵</kbd> ' + t('Select') + '</span><span><kbd>Esc</kbd> ' + t('Close') + '</span>'
      el.append(foot)
      // keep the scroll position across redraws, then make sure the selected row is fully inside the visible list (never under the footer)
      list.scrollTop = kept
      const cur = list.querySelector<HTMLElement>('.sel')
      if (cur) {
        if (cur.offsetTop - 6 < list.scrollTop) list.scrollTop = Math.max(0, cur.offsetTop - 6)
        else if (cur.offsetTop + cur.offsetHeight + 6 > list.scrollTop + list.clientHeight) list.scrollTop = cur.offsetTop + cur.offsetHeight + 6 - list.clientHeight
      }
    }
    const place = (props: any) => {
      const r = props.clientRect?.()
      if (!el || !r) return
      const h = Math.min(el.offsetHeight || 400, 400)
      const below = r.bottom + 6 + h < window.innerHeight
      el.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`
      el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`
    }

    return {
      onStart: (props: any) => {
        el = document.createElement('div')
        el.className = 'slash-menu'
        document.body.append(el)
        items = props.items
        selected = 0
        cmd = (i) => props.command(i)
        draw()
        place(props)
      },
      onUpdate: (props: any) => {
        items = props.items
        selected = 0
        cmd = (i) => props.command(i)
        draw()
        place(props)
      },
      onKeyDown: ({ event }: any) => {
        if (!items.length) return false
        const move = (d: number) => {
          selected = (selected + d + items.length) % items.length
          draw()
          return true
        }
        if (event.key === 'ArrowDown') return move(1)
        if (event.key === 'ArrowUp') return move(-1)
        if (event.key === 'Enter' || event.key === 'Tab') {
          cmd?.(items[selected])
          return true
        }
        return false
      },
      onExit: () => {
        el?.remove()
        el = null
      },
    }
  }
}
