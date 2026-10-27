export type PageKind = 'page' | 'folder' | 'board' | 'todo'
export type PageStatus = 'todo' | 'doing' | 'done'
export type Cover = { kind: 'gradient'; id: string } | { kind: 'image'; file: string } // image = content-addressed attachment id

export interface Page {
  id: string
  parentId: string | null
  kind?: PageKind // absent = page; a folder only groups other pages and has no content of its own; a board is a page that is one whole drawing
  title: string
  icon?: string
  cover?: Cover
  titleDir?: 'rtl' | 'ltr'
  tags?: string[]
  status?: PageStatus
  favorite: boolean
  sort: number // order among siblings (becomes sort_key in SQLite, see ADR-0002)
  content: any // TipTap JSON doc
  updatedAt: number
  deletedAt: number | null
  database?: any // present when the page is a database row (src/database); the editor never touches it
  recordMeta?: any // revision / provenance of the record, see src/database/model/types.ts
  dbHost?: string // id of the database container this page is the home of (src/database)
}

export type Patch = Partial<Pick<Page, 'title' | 'icon' | 'cover' | 'titleDir' | 'tags' | 'status' | 'favorite' | 'content' | 'parentId'>>

/** Shared operation surface retained for existing UI and database consumers. */
export interface PageRepo {
  init(): Promise<void>
  list(): Page[] // pages and folders
  pagesOnly(): Page[] // without folders
  get(id: string): Page | undefined
  create(parentId: string | null, kind?: PageKind): Page
  update(id: string, patch: Patch, opts?: { history?: boolean; copyContent?: boolean }): void // copyContent allocates new block identities for a document copy
  remove(id: string): void // soft delete, includes descendants
  search(query: string): Page[]
  backlinks(id: string): Page[] // pages that contain a pageLink to `id`
  linkGraph(): { nodes: Page[]; edges: [string, string][] } // pages and the page links between them
  move(id: string, parentId: string | null, beforeId: string | null): boolean // beforeId null = append
  trash(): Page[] // roots of deleted subtrees, newest first
  restoreFromTrash(id: string): void
  purge(id: string): void // permanent, includes descendants
  emptyTrash(): void
  autoPurge(maxAgeMs: number): number // permanently drops trash roots older than this; returns count
  dump(): Page[] // everything, including trash
  restore(pages: Page[]): void // replace everything
}
