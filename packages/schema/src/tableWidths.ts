/** SV 4: pixel widths are encoded as a string, preserving the scalar attribute contract. */
export function readColumnWidths(value: unknown): number[] {
  if (typeof value !== 'string' || value.length > 12000 || !value) return []
  try {
    const widths: unknown = JSON.parse(value)
    return Array.isArray(widths) && widths.length <= 1000 && widths.every(w => Number.isInteger(w) && w >= 0 && w <= 10000) ? widths : []
  } catch { return [] }
}

export const columnWidthsAttribute = {
  default: '',
  parseHTML: (el: HTMLElement) => {
    const widths = (el.getAttribute('data-colwidth') ?? el.getAttribute('colwidth') ?? '').split(',').map(Number)
    return widths.length && widths.some(w => w > 0) && widths.every(w => Number.isInteger(w) && w >= 0 && w <= 10000) ? JSON.stringify(widths) : ''
  },
  renderHTML: (attrs: Record<string, unknown>) => {
    const widths = readColumnWidths(attrs.colwidthJson)
    return widths.length ? { 'data-colwidth': widths.join(',') } : {}
  },
}
