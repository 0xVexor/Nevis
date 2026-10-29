/** One editor-local interaction channel for source chrome, drag previews and floating toolbars. */
export const LAYOUT_INTERACTION = 'layout-interaction'
export type LayoutInteraction = 'idle' | 'hover' | 'armed' | 'drag' | 'pick' | 'resize'

export function setLayoutInteraction(dom: HTMLElement, phase: LayoutInteraction) {
  const current = dom.dataset.layoutInteraction ?? 'idle'
  if (current === phase) return
  if (phase === 'idle') delete dom.dataset.layoutInteraction
  else dom.dataset.layoutInteraction = phase
  dom.dispatchEvent(new CustomEvent(LAYOUT_INTERACTION, { detail: phase }))
}

export function layoutInteractionBusy(dom: HTMLElement): boolean {
  return !!dom.dataset.layoutInteraction
}
