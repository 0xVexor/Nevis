// Tiny stroke icons as markup, for the DOM-built toolbars (image bar, zoom viewer) that cannot use the React icon set.
const wrap = (d: string, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`

export const svgIcon = {
  close: wrap('M6 6l12 12M18 6 6 18'),
  left: wrap('M4 6h16M4 12h10M4 18h14'),
  center: wrap('M4 6h16M7 12h10M5 18h14'),
  right: wrap('M4 6h16M10 12h10M6 18h14'),
  enlarge: wrap('M15 4h5v5M9 20H4v-5M20 4l-7 7M4 20l7-7'),
  reset: wrap('M4 12a8 8 0 1 0 3-6.2M4 4v5h5'),
  plus: wrap('M12 5v14M5 12h14'),
  minus: wrap('M5 12h14'),
}

/** Set a button's content: markup when it starts with an <svg>, plain text otherwise. */
export const setLabel = (b: HTMLElement, label: string) => (label.startsWith('<svg') ? (b.innerHTML = label) : (b.textContent = label))
