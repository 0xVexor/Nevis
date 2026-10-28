// Full JSON remains available and is the source of the selected version. The text view is only a preview.
export function conflictVersion(encoded: string | null): { title: string; text: string; raw: string; binary: boolean } {
  if (encoded === null) return { title: '', text: '', raw: '', binary: false }
  let raw: string
  try { const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return { title: '', text: '', raw: '', binary: true } }
  try {
    const value = JSON.parse(raw)
    raw = JSON.stringify(value, null, 2)
    const text = (node: any): string => {
      if (typeof node === 'string') return node
      if (node?.text !== undefined) return String(node.text)
      if (node?.type === 'hardBreak') return '\n'
      const children = (node?.content ?? []).map(text)
      return children.join(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node?.type) ? '\n' : '')
    }
    // Plain text is useful for notes. Structured records/drawings must retain every field in the comparison.
    const body = value.content?.type === 'doc' ? text(value.content) : raw
    return { title: String(value.title ?? value.name ?? ''), text: body, raw, binary: false }
  } catch { return { title: '', text: raw, raw, binary: false } }
}
export interface DiffRow { left: string | null; right: string | null; changed: boolean }
export function compareLines(left: string, right: string): DiffRow[] {
  const a = left.split('\n'), b = right.split('\n')
  // Bound the quadratic table for large notes. Full text still appears, without truncation.
  if (a.length * b.length > 250_000) return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ left: a[i] ?? null, right: b[i] ?? null, changed: a[i] !== b[i] }))
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  const rows: DiffRow[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ left: a[i++], right: b[j++], changed: false }); continue }
    const removed: string[] = [], added: string[] = []
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) removed.push(a[i++])
      else added.push(b[j++])
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) rows.push({ left: removed[k] ?? null, right: added[k] ?? null, changed: true })
  }
  return rows
}
