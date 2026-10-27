/** NV-MCP-04: proposed production wire contract. No tool handlers or vault access. */
export type Schema = Readonly<Record<string, unknown>>
export const CONTRACT_VERSION = '1' as const
export const LIMITS = Object.freeze({
  requestBytes: 262144, responseBytes: 65536, maxDepth: 32, maxNodes: 2000,
  pageSize: 100, textChars: 16000, operations: 100, cursorLifetimeMs: 900000,
})

const str = (maxLength = 256, minLength = 1): Schema => ({ type: 'string', minLength, maxLength })
const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum })
const bool: Schema = { type: 'boolean' }
const literal = (value: string | boolean): Schema => ({ const: value })
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values })
const array = (items: Schema, maxItems = 100, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems })
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })
const union = (...schemas: Schema[]): Schema => ({ oneOf: schemas })
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object', properties, required, additionalProperties: false,
})
const id = str()
const revision = str(256)
const cursor = str(4096)
const empty = obj({})
const docRef = { documentId: id, revision }
const blockRef = obj({ blockId: id })
const temporaryRef = obj({ temporaryId: id })
const editRef = union(blockRef, temporaryRef)
const range = obj({ fromBlockId: id, throughBlockId: id })
const pageRequest = { limit: integer(1, LIMITS.pageSize), cursor }
const budget = obj({ maxChars: integer(1, LIMITS.textChars), maxBlocks: integer(1, 100) })
const pageResult = { nextCursor: nullable(cursor), truncated: bool }
const freshness = obj({ state: choice('fresh', 'pending', 'failed'), indexedRevision: nullable(revision) })
const warning = obj({ code: choice('UNSUPPORTED_CONTENT', 'LOSSY_MARKDOWN', 'INDEX_PENDING', 'INDEX_FAILED'), message: str(512), blockIds: array(id) })

// Rich JSON is a preservation envelope, not the editor schema. Adapters must also
// check the negotiated node/mark/attribute capabilities and aggregate budgets.
const node: Schema = { $ref: '#/definitions/node' }
const definitions = {
  node: obj({ type: str(80), text: str(LIMITS.textChars, 0),
    attrs: { type: 'object' }, marks: array(obj({ type: str(80), attrs: { type: 'object' } }, ['type'])),
    content: array(node, LIMITS.maxNodes),
  }, ['type']),
}
const content = obj({ type: literal('doc'), content: array(node, LIMITS.maxNodes) })
const metadataFields = {
  title: str(512, 0), icon: nullable(str(128)), titleDir: nullable(choice('rtl', 'ltr')),
  tags: { ...array(str(128), 50), uniqueItems: true }, status: nullable(choice('todo', 'doing', 'done')),
  favorite: bool,
}
const metadata = obj(metadataFields, ['title', 'tags', 'favorite'])
const metadataPatch = { ...obj(metadataFields, []), minProperties: 1 }
const summary = obj({ documentId: id, revision, parentId: nullable(id), kind: choice('page', 'folder', 'board', 'todo'),
  metadata, updatedAt: integer(0, Number.MAX_SAFE_INTEGER) })
const capabilities = obj({
  contractVersion: literal(CONTRACT_VERSION), blockIdentity: literal('stable'),
  readableNodeTypes: array(str(80)), writableNodeTypes: array(str(80)), writableMarks: array(str(80)),
  writableAttributes: array(str(80)), operations: array(choice('insert_blocks', 'replace_blocks', 'move_blocks', 'delete_blocks', 'set_attributes', 'set_internal_link')),
  preservesUntouchedUnsupportedNodes: bool,
})
const chunk = obj({ range: nullable(range), markdown: nullable(str(LIMITS.textChars, 0)), structured: nullable(array(node, 100)) })
const readResult = obj({ ...docRef, capabilities, chunks: array(chunk), ...pageResult, warnings: array(warning) })
const receipt = obj({ operationId: id, documentId: id, beforeRevision: nullable(revision), afterRevision: revision,
  committedAt: integer(0, Number.MAX_SAFE_INTEGER), undoExpiresAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)) })
const saved = obj({ ...docRef, receipt, affectedBlockIds: array(id, LIMITS.maxNodes), savedContent: readResult,
  search: freshness, sync: choice('pending', 'synced', 'failed', 'disabled'), replayed: bool })
const location = union(
  obj({ position: choice('before', 'after'), target: editRef }),
  obj({ position: literal('end'), parent: nullable(editRef) }),
)
const inserted = obj({ temporaryId: id, node })
const targetRange = obj({ from: editRef, through: editRef })
const operations = array(union(
  obj({ kind: literal('insert_blocks'), at: location, blocks: array(inserted, 100, 1) }),
  obj({ kind: literal('replace_blocks'), target: targetRange, blocks: array(inserted, 100, 1) }),
  obj({ kind: literal('move_blocks'), target: targetRange, at: location }),
  obj({ kind: literal('delete_blocks'), target: targetRange }),
  obj({ kind: literal('set_attributes'), target: editRef,
    attributes: { ...obj({ dir: choice('auto', 'ltr', 'rtl'), level: integer(1, 6), checked: bool, language: nullable(str(80)) }, []), minProperties: 1 } }),
  obj({ kind: literal('set_internal_link'), target: editRef, destinationDocumentId: id, label: str(512) }),
), LIMITS.operations, 1)

export const ERROR_CODES = [
  'INVALID_ARGUMENT', 'LIMIT_EXCEEDED', 'ACCESS_DENIED', 'NOT_FOUND', 'REVISION_CONFLICT',
  'EDITOR_BUSY', 'UNSUPPORTED_CONTENT', 'INVALID_TARGET', 'STALE_CURSOR',
  'OPERATION_ID_MISMATCH', 'VERSION_EXPIRED', 'PERSISTENCE_FAILED', 'RECOVERY_REQUIRED',
  'APP_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE',
] as const
const error = obj({ ok: literal(false), error: union(...ERROR_CODES.map(code => obj({
  code: literal(code), message: str(512), retryable: bool,
  // Denied/missing resources cannot carry revision or other metadata.
  details: code === 'REVISION_CONFLICT' ? obj({ currentRevision: revision })
    : code === 'EDITOR_BUSY' || code === 'APP_UNAVAILABLE' ? obj({ retryAfterMs: integer(0, 60000) })
    : code === 'INVALID_ARGUMENT' || code === 'LIMIT_EXCEEDED' ? obj({ field: str(128) }) : empty,
}, ['code', 'message', 'retryable']))) })

function schema(value: Schema): Schema {
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...value, definitions }
}
function tool(input: Schema, result: Schema) {
  return Object.freeze({ inputSchema: schema(input), outputSchema: schema(union(obj({ ok: literal(true), result }), error)) })
}
const write = { documentId: id, expectedRevision: revision, operationId: id }

export const documentToolContracts = Object.freeze({
  list_documents: tool(obj({
    parentId: nullable(id), recursive: bool, kinds: array(choice('page', 'folder', 'board', 'todo'), 4, 1),
    tags: array(str(128), 50), favorite: bool, ...pageRequest,
  }, []), obj({ documents: array(summary), ...pageResult })),
  search_documents: tool(obj({
    query: str(2048), mode: choice('keywords', 'phrase', 'literal'), documentIds: array(id, 100, 1),
    tags: array(str(128), 50), budget, ...pageRequest,
  }, ['query', 'mode']), obj({ hits: array(obj({ ...docRef, range: nullable(range), source: choice('title', 'tag', 'body'), passage: str(4096), score: { type: 'number', minimum: 0 } }, ['documentId', 'revision', 'range', 'passage', 'score'])),
    search: freshness, ...pageResult, warnings: array(warning) })),
  read_document: tool(obj({ documentId: id, expectedRevision: revision,
    target: union(obj({ kind: literal('outline') }), obj({ kind: literal('full') }),
      obj({ kind: literal('section'), headingBlockId: id }), obj({ kind: literal('blocks'), blockIds: array(id, 100, 1) })),
    format: choice('markdown', 'structured', 'both'), budget, cursor,
  }, ['documentId', 'target', 'format']), readResult),
  create_document: tool(obj({ operationId: id, parentId: nullable(id), kind: choice('page', 'folder', 'board', 'todo'), metadata, content }), saved),
  edit_document: tool(obj({ ...write, mode: choice('preview', 'apply'), operations, budget },
    [...Object.keys(write), 'mode', 'operations']), union(
    obj({ mode: literal('preview'), documentId: id, baseRevision: revision, persisted: literal(false),
      changes: array(obj({ kind: choice('insert', 'replace', 'move', 'delete', 'attributes', 'link'), blockIds: array(id),
        before: str(4096, 0), after: str(4096, 0) })), truncated: bool, warnings: array(warning) }),
    obj({ mode: literal('apply'), saved }),
  )),
  update_document_metadata: tool(obj({ ...write, patch: metadataPatch }), saved),
  get_document_history: tool(obj({ documentId: id, versionId: id, format: choice('markdown', 'structured', 'both'), budget, ...pageRequest }, ['documentId']),
    obj({ documentId: id, versions: array(obj({ versionId: id, operationId: nullable(id), revision,
      committedAt: integer(0, Number.MAX_SAFE_INTEGER), expiresAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)) })),
    retainedContent: nullable(readResult), retention: obj({ earliestAvailableAt: nullable(integer(0, Number.MAX_SAFE_INTEGER)), complete: bool }), ...pageResult })),
  undo_document_edit: tool(obj({ ...write, undoOperationId: id }), saved),
})
export type DocumentToolName = keyof typeof documentToolContracts

/** Scope is supplied by the trusted host, never deserialized from tool input. */
export interface DocumentAccessContext {
  readonly vaultHandle: string
  readonly grantId: string
  readonly grantRevision: string
}
