/** A node of a saved TipTap / ProseMirror JSON document (the shape pages are stored and exchanged in). */
export interface DocNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: DocNode[]
}
