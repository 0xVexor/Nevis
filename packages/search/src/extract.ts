// What a page gives the derived indexes: its text (search), its links to other pages (backlinks, graph) and its tasks. Read from the
// page's ProseMirror JSON (the projection of the Y.Doc), so no editor and no DOM is needed.
export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string }
export interface PageTask { blockId: string; text: string; checked: boolean; due: string }
export interface PageLinkRef { dst: string; blockId: string }
export interface Extracted { text: string; links: PageLinkRef[]; tasks: PageTask[] }

const BLOCK_TEXT = new Set(['mathBlock', 'mermaid'])

const textOf = (n: PMNode): string => {
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'pageLink') return String(n.attrs?.label ?? '')
  if (n.type === 'mathInline') return String(n.attrs?.latex ?? '')
  if (n.type === 'image') return String(n.attrs?.alt ?? '')
  if (n.type === 'file') return String(n.attrs?.name ?? '')
  return (n.content ?? []).map(textOf).join('')
}

export function extractPage(doc: PMNode): Extracted {
  const lines: string[] = []
  const links: PageLinkRef[] = []
  const tasks: PageTask[] = []
  const walk = (n: PMNode, block: string) => {
    const id = typeof n.attrs?.blockId === 'string' && n.attrs.blockId ? n.attrs.blockId : block
    if (n.type === 'pageLink' && typeof n.attrs?.dstId === 'string' && n.attrs.dstId) links.push({ dst: n.attrs.dstId, blockId: block })
    if (n.type === 'taskItem') {
      const own = (n.content ?? []).filter(c => c.type === 'paragraph').map(textOf).join(' ').trim()
      tasks.push({ blockId: id, text: own, checked: n.attrs?.checked === true, due: String(n.attrs?.due ?? '') })
    }
    if (BLOCK_TEXT.has(n.type)) { lines.push(String(n.attrs?.latex ?? n.attrs?.code ?? '')); return }
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') { lines.push(textOf(n)); for (const c of n.content ?? []) walkInline(c, id); return }
    if (n.type === 'image' || n.type === 'file') { lines.push(textOf(n)); return }
    for (const c of n.content ?? []) walk(c, id)
  }
  const walkInline = (n: PMNode, block: string) => { if (n.type === 'pageLink' && typeof n.attrs?.dstId === 'string' && n.attrs.dstId) links.push({ dst: n.attrs.dstId, blockId: block }); for (const c of n.content ?? []) walkInline(c, block) }
  walk(doc, '')
  return { text: lines.filter(Boolean).join('\n'), links, tasks }
}
