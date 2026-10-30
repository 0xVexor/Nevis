// Serialized contracts of the database feature (docs/notion-database-handoff.md §5). Everything here is JSON-safe:
// no Date / Map / Set / Blob, so the same records travel through IndexedDB, Tauri IPC, the Vault folder and backups.

export type Id = string
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Stamp = { counter: number; deviceId: Id; opId: Id }

export type RecordMeta = {
  format: 1
  id: Id
  vaultId: Id
  revision: number
  createdAt: number
  updatedAt: number
  createdBy: Id
  updatedBy: Id
  deletedAt: number | null
  lastOperationId: Id
}

export type Kind =
  | 'title' | 'text' | 'number' | 'select' | 'multi_select' | 'status' | 'date'
  | 'people' | 'files' | 'checkbox' | 'url' | 'email' | 'phone' | 'relation' | 'rollup'
  | 'formula' | 'created_time' | 'created_by' | 'last_edited_time' | 'last_edited_by'
  | 'button' | 'unique_id' | 'place' | 'verification' | 'connected'

export const ALL_KINDS: Kind[] = [
  'title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'people', 'files', 'checkbox', 'url', 'email',
  'phone', 'relation', 'rollup', 'formula', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'button',
  'unique_id', 'place', 'verification', 'connected',
]

export type RichRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  color?: string
  href?: string
  mention?: { kind: 'page' | 'person'; id: Id }
}

export type CivilDate = { kind: 'date'; start: string; end: string | null }
export type InstantDate = { kind: 'datetime'; start: string; end: string | null; timeZone: string | null }
export type DateValue = CivilDate | InstantDate

export type Place = {
  lat: number | null
  lon: number | null
  name: string
  address: string
  provider?: string
  providerId?: string
  unresolved?: boolean
}

export type Cell =
  | { kind: 'text'; runs: RichRun[] }
  | { kind: 'number'; value: number | null }
  | { kind: 'select'; optionId: Id | null }
  | { kind: 'multi_select'; optionIds: Id[] }
  | { kind: 'status'; optionId: Id }
  | { kind: 'date'; value: DateValue | null }
  | { kind: 'people'; principalIds: Id[] }
  | { kind: 'files'; attachmentIds: Id[] }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'url' | 'email' | 'phone'; value: string | null }
  | { kind: 'place'; value: Place | null }
  | { kind: 'verification'; value: VerificationValue }
  | { kind: 'connected'; value: ConnectedValue | null }

/** A reference to one external object plus what was last fetched about it. The cache is tagged so a stale value stays visibly stale. */
export type ConnectedValue = {
  provider: string
  externalId: string
  canonicalUrl: string
  cache: { fields: Record<string, Json>; providerRevision: string; fetchedAt: number } | null
  /** last refresh failed: 'unauthorized' (connection revoked) / 'not_visible' / 'unavailable'; the cache is kept */
  status?: 'ok' | 'unauthorized' | 'not_visible' | 'unavailable'
}

export type VerificationValue = { state: 'verified' | 'unverified'; verifierId: Id | null; verifiedAt: number | null; expiresAt: number | null }

export type CellKind = Cell['kind']

export type Definition = RecordMeta & {
  sourceId: Id
  name: string
  description: string
  kind: Kind
  sortKey: string
  config: Json
}

export type SourceLink = { sourceId: Id; sortKey: string }

export type Container = RecordMeta & {
  hostPageId: Id
  presentation: 'inline' | 'full'
  title: string
  sourceLinks: SourceLink[]
}

export type Source = RecordMeta & {
  ownerContainerId: Id
  name: string
  schemaRevision: number
  titlePropertyId: Id
  defaultTemplateId: Id | null
  layout: Json
  settings: Json
}

/** Where an imported item came from. Unique per (provider, externalSourceId, externalObjectId); a tombstoned item stays as a row with its local overlays. */
export type ExternalIdentity = { provider: string; externalSourceId: string; externalObjectId: string; revision: string; fetchedAt: number; url: string; tombstoned: boolean }
export type ImportSettings = { provider: string; externalSourceId: string; fieldMap: Record<string, Id>; identityMap: Record<string, Id>; statusMap: Record<string, Id> }

export type RowExtension = {
  format: 1
  sourceId: Id
  schemaRevision: number
  revision: number
  sortKey: string
  parentItemId: Id | null
  cells: Record<Id, { value: Cell; stamp: Stamp }>
  allocatedIds: Record<Id, string>
  archivedCells: Json
  external?: ExternalIdentity
}

export type RelationDefinition = RecordMeta & {
  propertyId: Id
  sourceId: Id
  targetSourceId: Id
  mode: 'one_way' | 'paired' | 'self_symmetric'
  inversePropertyId: Id | null
  cardinality: 'one' | 'many'
  inverseCardinality: 'one' | 'many'
  displayedPropertyIds: Id[]
}

export type RelationEdge = RecordMeta & {
  definitionId: Id
  fromPageId: Id
  toPageId: Id
  sortKey: string
  stamp: Stamp
}

export type ViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart' | 'map' | 'feed' | 'form' | 'dashboard'
export const VIEW_TYPES: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart', 'map', 'feed', 'form', 'dashboard']

export type Filter = { kind: 'and' | 'or'; children: Filter[] } | { kind: 'predicate'; propertyId: Id; op: string; operand?: Json }
export type Sort = { propertyId: Id; direction: 'asc' | 'desc' }

export type View = RecordMeta & {
  containerId: Id
  sourceId: Id | null
  parentDashboardId: Id | null
  type: ViewType
  name: string
  sortKey: string
  filter: Filter | null
  sorts: Sort[]
  configuration: Json
  defaultTemplateId: Id | null
}

// ───── derived / evaluated values ─────

export type FormulaValue =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; runs: RichRun[] }
  | { kind: 'date'; value: DateValue }
  | { kind: 'page'; id: Id; vaultId: Id }
  | { kind: 'person'; id: Id }
  | { kind: 'list'; items: FormulaValue[] }

export type FormulaDiagnostic = { code: string; message: string; from: number; to: number }

export type Computed =
  | { state: 'ready'; value: FormulaValue }
  | { state: 'pending' | 'restricted' }
  | { state: 'error'; code: string; detail: string }

export type FormulaResult =
  | { state: 'ready'; value: FormulaValue }
  | { state: 'error'; diagnostics: FormulaDiagnostic[] }
  | { state: 'pending' | 'restricted' }

// ───── query ─────

export type Query = {
  vaultId: Id
  sourceId: Id
  viewId?: Id
  principalId: Id
  filter: Filter | null
  sorts: Sort[]
  search: string
  projection: Id[]
  limit: number
  cursor?: string
  now: string
  timeZone: string
  expectedGeneration?: number
}

export type GroupSpec =
  | { propertyId: Id; mode?: 'option' | 'status_group' | 'exact' | 'prefix' | 'day' | 'week' | 'month' | 'year' | 'relative' | 'bucket'; prefixLength?: number; bucketStart?: number; bucketSize?: number; hidden?: Id[]; order?: Id[] }

export type QueryGroup = { key: string; label: string; memberId: Id | null; pageIds: Id[]; count: number; aggregates?: Record<Id, Json> }

export type QueryPage = {
  generation: number
  pageIds: Id[]
  rows: Json[]
  total: number
  groups: QueryGroup[]
  totals: Json
  nextCursor: string | null
  incomplete: boolean
  diagnostics: { code: string; detail: string }[]
}

// ───── command envelope ─────

export type CommandEnvelope = {
  operationId: Id
  vaultId: Id
  actorId: Id
  deviceId: Id
  expected: { recordKind: string; id: Id; revision: number }[]
  origin: 'user' | 'button' | 'automation' | 'template' | 'import' | 'external'
  commands: { type: string; payload: Json }[]
}

export type Commit = {
  operationId: Id
  generation: number
  changed: { recordKind: string; id: Id; revision: number }[]
  warnings: { code: string; detail: string }[]
  /** ids/values created by the batch (new row ids etc.), so a retried operation returns the same answer */
  result?: Json
}

// ───── record kinds stored in the Vault `databases/` folders ─────

export type RecordKind =
  | 'container' | 'source' | 'property' | 'view' | 'relation' | 'edge' | 'template' | 'workflow'
  | 'comment' | 'principal' | 'grant' | 'event' | 'allocator'

export const RECORD_KINDS: RecordKind[] = [
  'container', 'source', 'property', 'view', 'relation', 'edge', 'template', 'workflow', 'comment', 'principal', 'grant', 'event', 'allocator',
]

export const RECORD_DIR: Record<RecordKind, string> = {
  container: 'containers', source: 'sources', property: 'properties', view: 'views', relation: 'relations', edge: 'edges',
  template: 'templates', workflow: 'workflows', comment: 'comments', principal: 'principals', grant: 'grants', event: 'events', allocator: 'allocators',
}

export type Principal = RecordMeta & {
  type: 'user' | 'group'
  displayName: string
  email: string | null
  memberIds: Id[]
  /** the local owner exists explicitly; a real directory can add others later */
  isLocalOwner: boolean
  externalId: string | null
}

export type Right = 'full' | 'edit' | 'edit_content' | 'create' | 'comment' | 'view'
export const RIGHT_ORDER: Right[] = ['view', 'comment', 'create', 'edit_content', 'edit', 'full']

export type Grant = RecordMeta & {
  principalId: Id
  /** database-level grant when pageId is null */
  containerId: Id | null
  sourceId: Id | null
  pageId: Id | null
  right: Right
  /** property-level policy; absent = inherit */
  propertyId: Id | null
  propertyRights: { seeDefinition: boolean; readValues: boolean; editValues: boolean; editDefinition: boolean } | null
  /** row rule: person/created-by property whose membership grants access to the row */
  viaPropertyId: Id | null
}

export type Allocator = RecordMeta & {
  sourceId: Id
  propertyId: Id
  /** `partitioned`: device namespace + local counter; `sequential`: one authority counter */
  mode: 'sequential' | 'partitioned'
  allocatorId: Id
  next: number
}

export type TemplateRecord = RecordMeta & {
  sourceId: Id
  name: string
  icon: string | null
  cover: Json
  /** default cell values by property id */
  defaults: Record<Id, Json>
  /** copied body tree (TipTap JSON) */
  body: Json
  /** nested template references created together with the page */
  nested: { sourceId: Id; templateId: Id }[]
  repeat: RepeatSchedule | null
  scheduleVersion: number
}

export type RepeatSchedule = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  startDate: string // civil
  endDate: string | null
  time: string // HH:mm local
  timeZone: string
  weekdays?: number[] // 1=Monday..7=Sunday
  dayOfMonth?: number
}

export type CommentRecord = RecordMeta & {
  pageId: Id
  propertyId: Id | null
  parentCommentId: Id | null
  authorId: Id
  body: RichRun[]
  resolved: boolean
  editedAt: number | null
  readBy: Id[]
}

export type EventRecord = RecordMeta & {
  type: 'view' | 'audit' | 'workflow_run' | 'form_receipt' | 'reminder'
  pageId: Id | null
  principalId: Id | null
  data: Json
}

export type Trigger =
  | { type: 'page_added' }
  | { type: 'property_changed'; propertyId: Id; predicate?: Filter }
  | { type: 'schedule'; recurrence: Json }

export type Action =
  | { type: 'set_values'; target: Json; changes: Json }
  | { type: 'create_page'; sourceId: Id; templateId?: Id; values: Json }
  | { type: 'edit_matching'; query: Json; changes: Json }
  | { type: 'define_variable'; name: string; expression: string }
  | { type: 'notify'; recipients: Json; message: string }
  | { type: 'confirm'; title: string; message: string }
  | { type: 'open'; pageId?: Id; url?: string }
  | { type: 'webhook'; connectionId: Id; request: Json }
  | { type: 'email' | 'slack'; connectionId: Id; message: Json }

export type WorkflowRecord = RecordMeta & {
  sourceId: Id
  name: string
  kind: 'button' | 'automation'
  /** automation only */
  triggers: Trigger[]
  triggerMode: 'any' | 'all'
  viewScopeId: Id | null
  actions: Action[]
  enabled: boolean
  definitionRevision: number
  /** buttons: property id the button lives in */
  propertyId: Id | null
  paused: boolean
}

// ───── shared page access (the engine never imports the app's Repo) ─────

export interface PageLike {
  id: Id
  parentId: Id | null
  kind?: string
  title: string
  icon?: string
  cover?: Json
  content?: Json
  updatedAt: number
  deletedAt: number | null
  database?: RowExtension
  recordMeta?: PageRecordMeta
  [extra: string]: unknown
}

export type PageRecordMeta = {
  format: 1
  revision: number
  createdAt: number
  createdBy: Id
  updatedBy: Id
  lastOperationId: Id
  /** createdAt was inferred (legacy page), not observed */
  inferred?: boolean
}
