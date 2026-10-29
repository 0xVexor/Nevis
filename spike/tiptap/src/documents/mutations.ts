import type { AssetUpload } from './assets.ts'
import { cloneDocumentValue } from './clone.ts'
import { isBlockId } from './blockIdentity.ts'
import { DocumentPlanError, planDocumentEdit, validateDocumentJson } from './editPlanner.ts'
import type { EditNode, EditOperation, EditPlannerRuntime } from './editPlanner.ts'
import { documentRevision } from './revision.ts'
import type { Page, PageKind, PageStatus, Cover } from './model.ts'

export interface DocumentMetadata {
  title: string; tags: string[]; favorite: boolean; cover?: Cover | null
  icon?: string | null; titleDir?: 'rtl' | 'ltr' | null; status?: PageStatus | null
}
export interface CreateDocumentInput {
  operationId: string; parentId: string | null; kind: PageKind
  metadata: DocumentMetadata; assets?: AssetUpload[]; content: { type: 'doc'; content: EditNode[] }
}
export interface UpdateDocumentMetadataInput {
  operationId: string; documentId: string; expectedRevision: string; patch: Partial<DocumentMetadata>
}
function fail(code: 'INVALID_ARGUMENT' | 'UNSUPPORTED_CONTENT' | 'CAPABILITY_UNAVAILABLE' | 'ACCESS_DENIED'): never { throw new DocumentPlanError(code) }
function fields(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_ARGUMENT')
}
const string = (value: unknown, max: number, min = 1): value is string => typeof value === 'string' && [...value].length >= min && [...value].length <= max
function validateCover(value: unknown) {
  if (value === null) return
  fields(value, ['kind', 'id', 'file'], ['kind'])
  fields(value, value.kind === 'gradient' ? ['kind', 'id'] : ['kind', 'file'])
  if (value.kind === 'gradient' ? !string(value.id, 80) : value.kind !== 'image' || typeof value.file !== 'string' || !/^[a-f0-9]{64}$/.test(value.file)) fail('INVALID_ARGUMENT')
}
export function validateMetadata(value: Partial<DocumentMetadata>, full: boolean) {
  fields(value, ['title', 'tags', 'favorite', 'icon', 'titleDir', 'status', 'cover'], full ? ['title', 'tags', 'favorite'] : [])
  if (!Object.keys(value).length) fail('INVALID_ARGUMENT')
  for (const [key, item] of Object.entries(value)) {
    if (key === 'cover') { validateCover(item); continue }
    if (key === 'title' ? !string(item, 512, 0)
      : key === 'tags' ? !Array.isArray(item) || item.length > 50 || item.some(tag => !string(tag, 128)) || new Set(item).size !== item.length
      : key === 'favorite' ? typeof item !== 'boolean'
      : key === 'icon' ? item !== null && !string(item, 128)
      : key === 'titleDir' ? item !== null && !['rtl', 'ltr'].includes(item as string)
      : item !== null && !['todo', 'doing', 'done'].includes(item as string)) fail('INVALID_ARGUMENT')
  }
}
export function applyMetadata(page: Page, metadata: Partial<DocumentMetadata>) {
  const after = cloneDocumentValue(page)
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) delete (after as unknown as Record<string, unknown>)[key]
    else (after as unknown as Record<string, unknown>)[key] = cloneDocumentValue(value)
  }
  return after
}
export function metadataEvidence(page: Page): DocumentMetadata {
  const metadata: DocumentMetadata = { title: page.title, tags: page.tags ?? [], favorite: page.favorite,
    icon: page.icon ?? null, titleDir: page.titleDir ?? null, status: page.status ?? null, ...(page.cover ? { cover: cloneDocumentValue(page.cover) } : {}) }
  try { validateMetadata(metadata, true) } catch { fail('CAPABILITY_UNAVAILABLE') }
  return metadata
}
export function validateCreate(input: CreateDocumentInput) {
  validateDocumentJson(input); fields(input, ['operationId', 'parentId', 'kind', 'metadata', 'content', 'assets'], ['operationId', 'parentId', 'kind', 'metadata', 'content'])
  if (!isBlockId(input.operationId) || (input.parentId !== null && !string(input.parentId, 256)) || !['page', 'folder', 'board', 'todo'].includes(input.kind)) fail('INVALID_ARGUMENT')
  validateMetadata(input.metadata, true)
  fields(input.content, ['type', 'content'])
  if (input.content.type !== 'doc' || !Array.isArray(input.content.content)) fail('INVALID_ARGUMENT')
}
export function validateMetadataUpdate(input: UpdateDocumentMetadataInput) {
  validateDocumentJson(input); fields(input, ['operationId', 'documentId', 'expectedRevision', 'patch'])
  if (!isBlockId(input.operationId) || !string(input.documentId, 256) || !string(input.expectedRevision, 256)) fail('INVALID_ARGUMENT')
  validateMetadata(input.patch, false)
}
/** Reuse the closed writable profile; the scaffold is never persisted. */
export async function prepareCreatedPage(input: CreateDocumentInput, id: string, sort: number, runtime: EditPlannerRuntime) {
  if (input.kind === 'board' && (input.content.content.length !== 1 || input.content.content[0]?.type !== 'drawing')) fail('UNSUPPORTED_CONTENT')
  if (input.metadata.cover?.kind === 'image' && !runtime.canUseResource?.('attachment', input.metadata.cover.file)) fail('ACCESS_DENIED')
  if (input.kind === 'folder' && (input.content.content.length !== 1 || input.content.content[0]?.type !== 'paragraph'
    || (input.content.content[0].content?.length ?? 0) !== 0)) fail('UNSUPPORTED_CONTENT')
  if (input.kind === 'todo' && input.content.content[0]?.type !== 'taskList') fail('UNSUPPORTED_CONTENT')
  const scaffold: Page = { id, parentId: input.parentId, ...(input.kind !== 'page' ? { kind: input.kind } : {}), title: '', tags: [], favorite: false, sort,
    updatedAt: 0, deletedAt: null, content: { type: 'doc', attrs: { blockIdentityVersion: 1 }, content: [{ type: 'paragraph', attrs: { blockId: 'create_scaffold' } }] } }
  const operations: EditOperation[] = [{ kind: 'delete_blocks', target: { from: { blockId: 'create_scaffold' }, through: { blockId: 'create_scaffold' } } }]
  for (let start = 0; start < input.content.content.length; start += 100) operations.push({ kind: 'insert_blocks', at: { position: 'end', parent: null },
    ...(start === 0 && input.assets ? { assets: input.assets } : {}), blocks: input.content.content.slice(start, start + 100).map((node, index) => ({ temporaryId: `create_${start + index}`, node })) })
  // Folder scaffolds use the same structural validator as pages, then restore their kind.
  const plan = await planDocumentEdit({ ...scaffold, kind: undefined }, { documentId: id, expectedRevision: await documentRevision({ ...scaffold, kind: undefined }, runtime.digest),
    operationId: input.operationId, mode: 'apply', operations }, runtime)
  const after = applyMetadata(plan.after, input.metadata)
  if (input.kind === 'page') delete after.kind; else after.kind = input.kind
  return { after, assets: plan.assets, affected: plan.affectedBlockIds.filter(blockId => blockId !== 'create_scaffold') }
}
