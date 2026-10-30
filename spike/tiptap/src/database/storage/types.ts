// Storage boundary of the database feature. One batch is one durable, idempotent unit: the adapter writes a redo journal, marks it
// committed, applies the post-images, updates its index and marks the journal applied (handoff §6). Implementations: in-memory
// (tests, preview), IndexedDB (browser), Tauri/Vault (desktop).
import type { Commit, Id, Json, PageLike, RecordKind } from '../model/types.ts'
import type { AnyRecord } from '../state.ts'

export type RecordWrite = {
  kind: RecordKind
  id: Id
  /** revision the file must have right now (0 = must not exist). Used for recovery and to refuse a stale writer. */
  baseRevision: number
  /** null = remove the record file (purge only; normal deletion is a tombstone) */
  after: AnyRecord | null
}

export type PageWrite = {
  id: Id
  baseRevision: number
  /** Full page observed when the batch was prepared, or null for a new page. */
  before?: PageLike | null
  after: PageLike | null
}

export type HistoryWrite = { recordKind: string; id: Id; revision: number; body: Json }

export type UndoItem =
  | { t: 'record'; kind: RecordKind; id: Id; afterRevision: number; before: AnyRecord | null }
  | { t: 'page'; id: Id; afterRevision: number; paths: UndoPath[]; created: boolean }

/** One touched field of a page: undo only restores it while the current value is still the one this batch wrote. */
export type UndoPath = { path: string; before: Json | null; after: Json | null }

export type UndoGroup = { operationId: Id; label: string; ts: number; actorId: Id; items: UndoItem[] }

export type BatchWrite = {
  operationId: Id
  vaultId: Id
  records: RecordWrite[]
  pages: PageWrite[]
  history: HistoryWrite[]
  commit: Commit
  undo: UndoGroup | null
}

export type LoadedDatabase = {
  records: { [K in RecordKind]?: AnyRecord[] }
  /** records the adapter refused to interpret (newer format / corrupt): kept untouched, reported read-only */
  quarantined: { kind: string; id: string; reason: string }[]
}

export interface DbStorage {
  /** replay committed-but-unapplied journals. Throws RECOVERY_REQUIRED if a file does not match either side of a journal. */
  recover(): Promise<{ replayed: number }>
  loadAll(): Promise<LoadedDatabase>
  /** durable, atomic from the app's point of view. Throws IO / QUOTA with nothing applied on failure before the journal commit. */
  commit(batch: BatchWrite): Promise<void>
  getOperation(operationId: Id): Promise<Commit | undefined>
  loadUndo(): Promise<UndoGroup[]>
  saveUndo(groups: UndoGroup[]): Promise<void>
  history(recordKind: string, id: Id): Promise<{ revision: number; body: Json }[]>
  /** derived index maintenance; the canonical files are the truth */
  rebuildIndex?(): Promise<void>
}

/** The app side of page storage: the engine asks it to adopt post-images after a batch is durable. */
export interface PageHost {
  get(id: Id): PageLike | undefined
  all(): PageLike[]
  /** replace/insert the given post-images in memory (and remove ids in `removed`) without scheduling a second write */
  adopt(upserts: PageLike[], removed: Id[]): void
  /** wait until pending page writes reached the store, so revisions in memory and on disk agree before a batch is built */
  flush?(): Promise<void>
  /** Prevent live editor/repository edits until durable publication finishes. */
  reserveCommit?(): Promise<() => void>
}
