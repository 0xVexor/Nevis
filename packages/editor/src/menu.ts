// A small floating list used by the slash menu and the page-link suggestion: keyboard (arrows, Enter, Escape) and mouse.
export interface MenuItem { id: string; title: string; hint?: string; icon?: string }

export class Menu {
  private readonly el = document.createElement('div')
  private items: MenuItem[] = []
  private sel = 0
  private pick: (item: MenuItem) => void = () => {}
  private readonly emptyText: string
  constructor(emptyText: string) {
    this.emptyText = emptyText
    this.el.className = 'floating-menu'
    this.el.setAttribute('role', 'listbox')
    this.el.setAttribute('dir', 'rtl')
    this.el.style.display = 'none'
    this.el.onmousedown = e => e.preventDefault() // the editor keeps focus
    document.body.append(this.el)
  }
  get visible() { return this.el.style.display !== 'none' }
  show(items: MenuItem[], rect: DOMRect | null, pick: (item: MenuItem) => void) {
    if (!this.el.isConnected) document.body.append(this.el) // removed on exit; the same Menu serves the next session
    this.items = items; this.pick = pick; this.sel = Math.min(this.sel, Math.max(0, items.length - 1))
    this.el.textContent = ''
    if (!items.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = this.emptyText; this.el.append(e) }
    items.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === this.sel ? ' sel' : '')
      row.setAttribute('role', 'option'); row.dataset.id = it.id
      row.innerHTML = ''
      const t = document.createElement('span'); t.className = 'title'; t.textContent = it.title
      row.append(t)
      if (it.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = it.hint; row.append(h) }
      row.onclick = () => this.pick(it)
      row.onmouseenter = () => { this.sel = i; this.mark() }
      this.el.append(row)
    })
    this.el.style.display = 'block'
    if (rect) {
      const top = rect.bottom + 4, vh = window.innerHeight
      this.el.style.insetInlineStart = 'auto'
      this.el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`
      this.el.style.top = `${top + 260 > vh ? Math.max(8, rect.top - 264) : top}px`
    }
    this.mark()
  }
  private mark() { Array.from(this.el.querySelectorAll('.row')).forEach((r, i) => { r.classList.toggle('sel', i === this.sel); if (i === this.sel) (r as HTMLElement).scrollIntoView?.({ block: 'nearest' }) }) }
  /** returns true if the key was used */
  key(e: KeyboardEvent): boolean {
    if (!this.visible) return false
    if (e.key === 'ArrowDown') { this.sel = (this.sel + 1) % Math.max(1, this.items.length); this.mark(); return true }
    if (e.key === 'ArrowUp') { this.sel = (this.sel - 1 + Math.max(1, this.items.length)) % Math.max(1, this.items.length); this.mark(); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { const it = this.items[this.sel]; if (it) { this.pick(it); return true } return false }
    if (e.key === 'Escape') { this.hide(); return true }
    return false
  }
  hide() { this.el.style.display = 'none'; this.sel = 0 }
  destroy() { this.el.remove() }
}
