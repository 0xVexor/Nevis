// The shapes the shell's screens read. Same field names as the old app's page model, so the screens copied from it stay as they were;
// `adapt.ts` fills them from the new data layer (the page registers and the derived index).
export type PageKind = 'page' | 'folder' | 'board' | 'todo' | 'deck'
export type PageStatus = 'todo' | 'doing' | 'done'
export type Cover = { kind: 'gradient'; id: string } | { kind: 'image'; file: string }

export interface Page {
  id: string
  parentId: string | null
  kind?: PageKind
  title: string
  icon?: string
  cover?: Cover
  titleDir?: 'rtl' | 'ltr'
  tags?: string[]
  status?: PageStatus
  favorite: boolean
  /** order among siblings */
  sort: number
  /** a document with one paragraph of text (enough for an excerpt) */
  content: unknown
  updatedAt: number
  deletedAt: number | null
  /** present when the page is a database (the tree shows it as a page) */
  database?: object
}

export interface Task { pageId: string; index: number; text: string; checked: boolean; depth: number }
