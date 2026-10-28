import { BLOCK_TYPES, BLOCK_IDENTITY_VERSION, identityVersion, isBlockId } from './blockIdentity.ts'
import { cloneDocumentValue } from './clone.ts'
import { LIMITS } from './contracts.ts'
import type { Page } from './model.ts'
import { canonicalDocumentValue, documentRevision } from './revision.ts'

export interface EditNode {
  type: string; text?: string; attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: EditNode[]
}
export type EditReference = { blockId: string } | { temporaryId: string }
export type EditRange = { from: EditReference; through: EditReference }
export type EditLocation = { position: 'before' | 'after'; target: EditReference } | { position: 'end'; parent: EditReference | null }
export interface InsertedBlock { temporaryId: string; node: EditNode }
export type EditOperation =
  | { kind: 'insert_blocks'; at: EditLocation; blocks: InsertedBlock[] }
  | { kind: 'replace_blocks'; target: EditRange; blocks: InsertedBlock[] }
  | { kind: 'move_blocks'; target: EditRange; at: EditLocation }
  | { kind: 'delete_blocks'; target: EditRange }
  | { kind: 'set_attributes'; target: EditReference; attributes: { dir?: 'auto' | 'ltr' | 'rtl'; level?: number; checked?: boolean; language?: string | null } }
  | { kind: 'set_internal_link'; target: EditReference; destinationDocumentId: string; label: string }
export interface EditDocumentInput {
  documentId: string; expectedRevision: string; operationId: string; mode: 'preview' | 'apply'
  operations: EditOperation[]; budget?: { maxChars: number; maxBlocks: number }
}
export interface EditPlannerRuntime {
  digest(snapshot: string): Promise<string>
  /** Host-owned, side-effect-free policy snapshot. No title lookup or note dereference. */
  canLink(documentId: string): boolean
}
type Code = 'INVALID_ARGUMENT' | 'LIMIT_EXCEEDED' | 'INVALID_TARGET' | 'UNSUPPORTED_CONTENT' | 'CAPABILITY_UNAVAILABLE' | 'REVISION_CONFLICT' | 'ACCESS_DENIED' | 'APP_UNAVAILABLE'
export class DocumentPlanError extends Error {
  readonly retryable: boolean
  readonly code: Code
  constructor(code: Code) { super(code.replaceAll('_', ' ').toLowerCase()); this.code = code; this.retryable = code === 'APP_UNAVAILABLE' }
}
function fail(code: Code): never { throw new DocumentPlanError(code) }
const writable = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'codeBlock', 'horizontalRule']
const writableSet = new Set(writable)
const inlines = new Set(['text', 'hardBreak', 'pageLink'])
const marks = new Set(['bold', 'italic', 'strike', 'underline', 'code'])
const blockTypes = new Set<string>(BLOCK_TYPES)
const containers = new Set(['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'layoutColumn'])
export const EDIT_PROFILE_VERSION = 1
export const EDIT_CAPABILITIES = Object.freeze({
  writableNodeTypes: [...writable, ...inlines], writableMarks: [...marks],
  writableAttributes: ['dir', 'level', 'checked', 'language'],
  operations: ['insert_blocks', 'replace_blocks', 'move_blocks', 'delete_blocks', 'set_attributes', 'set_internal_link'],
  preservesUntouchedUnsupportedNodes: true,
})
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
function fields(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, any> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_ARGUMENT')
}
const string = (v: unknown, max = 256, min = 1): v is string => typeof v === 'string' && [...v].length >= min && [...v].length <= max
const integer = (v: unknown, max: number): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= max
const bytes = (s: string) => { let n = 0; for (const c of s) { const cp = c.codePointAt(0)!; n += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4 } return n }

/** Bound recursion/work before cloning or stringifying untrusted JSON. */
function json(value: unknown, limit: number, optionalUndefined = false) {
  let work = 0
  const stack = new Set<object>()
  const visit = (v: unknown, depth: number) => {
    if (++work > LIMITS.maxNodes * 64 || depth > LIMITS.maxDepth * 2 + 8) fail('LIMIT_EXCEEDED')
    if (optionalUndefined && v === undefined) return
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return
    if (!v || typeof v !== 'object' || stack.has(v)) fail('INVALID_ARGUMENT')
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) fail('INVALID_ARGUMENT')
    stack.add(v)
    for (const item of Object.values(v)) visit(item, depth + 1)
    stack.delete(v)
  }
  visit(value, 0)
  if (bytes(JSON.stringify(value)) > limit) fail('LIMIT_EXCEEDED')
}
export function validateDocumentJson(value: unknown) { json(value, LIMITS.requestBytes) }
function reference(ref: unknown) {
  if (!object(ref)) fail('INVALID_ARGUMENT')
  const key = Object.hasOwn(ref, 'blockId') ? 'blockId' : 'temporaryId'
  fields(ref, [key]); if (!isBlockId(ref[key])) fail('INVALID_ARGUMENT')
}
function range(target: EditRange) { fields(target, ['from', 'through']); reference(target.from); reference(target.through) }
function location(at: EditLocation) {
  if (at?.position === 'end') { fields(at, ['position', 'parent']); if (at.parent !== null) reference(at.parent) }
  else { fields(at, ['position', 'target']); if (!['before', 'after'].includes(at.position)) fail('INVALID_ARGUMENT'); reference(at.target) }
}
const attributeTypes: Record<string, readonly string[]> = {
  dir: ['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem'], level: ['heading'], checked: ['taskItem'], language: ['codeBlock'],
}
function attributes(attrs: Record<string, unknown>) {
  fields(attrs, Object.keys(attributeTypes), [])
  if (!Object.keys(attrs).length) fail('INVALID_ARGUMENT')
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'dir' ? !['auto', 'ltr', 'rtl'].includes(value as string)
      : key === 'level' ? !integer(value, 6)
      : key === 'checked' ? typeof value !== 'boolean'
      : value !== null && !string(value, 80)) fail('INVALID_ARGUMENT')
  }
}

type Entry = { node: EditNode; parent: EditNode; ancestors: EditNode[] }
type Change = { kind: 'insert' | 'replace' | 'move' | 'delete' | 'attributes' | 'link'; blockIds: string[]; before: string; after: string }
export interface EditPreview {
  mode: 'preview'; documentId: string; baseRevision: string; persisted: false
  changes: Change[]; truncated: boolean; warnings: { code: 'UNSUPPORTED_CONTENT'; message: string; blockIds: string[] }[]
}
export interface DocumentEditPlan {
  before: Page; after: Page; affectedBlockIds: string[]; temporaryIds: Record<string, string>; preview: EditPreview
}

export function validateEditRequest(input: EditDocumentInput) {
  json(input, LIMITS.requestBytes)
  fields(input, ['documentId', 'expectedRevision', 'operationId', 'mode', 'operations', 'budget'], ['documentId', 'expectedRevision', 'operationId', 'mode', 'operations'])
  if (!string(input.documentId) || !string(input.expectedRevision) || !isBlockId(input.operationId)
    || !['preview', 'apply'].includes(input.mode) || !Array.isArray(input.operations) || !input.operations.length) fail('INVALID_ARGUMENT')
  if (input.operations.length > LIMITS.operations) fail('LIMIT_EXCEEDED')
  if (input.budget !== undefined) {
    fields(input.budget, ['maxChars', 'maxBlocks'])
    if (!integer(input.budget.maxChars, LIMITS.textChars) || !integer(input.budget.maxBlocks, 100)) fail('INVALID_ARGUMENT')
  }
}

/** Pure planning: no storage, timers, IDs from the UI, or editor singleton. Apply uses this same planner. */
export async function planDocumentEdit(source: Page, input: EditDocumentInput, runtime: EditPlannerRuntime): Promise<DocumentEditPlan> {
  validateEditRequest(input); json(source, LIMITS.requestBytes * 16, true)
  if (!object(source) || !string(source.id)) fail('CAPABILITY_UNAVAILABLE')
  input = cloneDocumentValue(input)
  const before = cloneDocumentValue(source), after = cloneDocumentValue(source)
  if (input.documentId !== before.id) fail('INVALID_ARGUMENT')
  if (before.kind === 'folder' || before.deletedAt !== null || !object(after.content) || after.content.type !== 'doc'
    || identityVersion(after.content) !== BLOCK_IDENTITY_VERSION) fail('CAPABILITY_UNAVAILABLE')
  let revision: string, seed: string
  try { revision = await documentRevision(before, value => runtime.digest(value)) }
  catch { fail('APP_UNAVAILABLE') }
  if (revision !== input.expectedRevision) fail('REVISION_CONFLICT')
  // Exclude presentation options so preview/apply allocate exactly the same IDs.
  try { seed = await runtime.digest(canonicalDocumentValue({ profile: EDIT_PROFILE_VERSION, documentId: before.id, revision: input.expectedRevision, operationId: input.operationId, operations: input.operations })) }
  catch { fail('APP_UNAVAILABLE') }
  if (!/^[a-f0-9]{64}$/.test(seed)) fail('APP_UNAVAILABLE')
  const root = after.content as EditNode, temporary = new Map<string, string>(), reserved = new Set<string>()
  const changes: Change[] = [], affected = new Set<string>()
  let entries = new Map<string, Entry>(), serial = 0, protectedContent = false
  function index() {
    entries = new Map(); let count = 0
    const walk = (node: EditNode, parent: EditNode, ancestors: EditNode[], depth: number) => {
      if (++count > LIMITS.maxNodes || depth > LIMITS.maxDepth) fail('LIMIT_EXCEEDED')
      if (!object(node) || !string(node.type, 80) || (node.content !== undefined && !Array.isArray(node.content)) || (node.attrs !== undefined && !object(node.attrs))) fail('UNSUPPORTED_CONTENT')
      if (node.marks !== undefined && (!Array.isArray(node.marks) || node.marks.some(mark => !object(mark) || !string(mark.type, 80)))) fail('UNSUPPORTED_CONTENT')
      if (node.marks?.some(mark => !marks.has(mark.type))) protectedContent = true
      const id = node.attrs?.blockId
      if (blockTypes.has(node.type) && !isBlockId(id)) fail('CAPABILITY_UNAVAILABLE')
      if (id !== undefined) {
        if (!isBlockId(id) || entries.has(id)) fail('CAPABILITY_UNAVAILABLE')
        entries.set(id, { node, parent, ancestors }); reserved.add(id)
      }
      node.content?.forEach(child => walk(child, node, [...ancestors, node], depth + 1))
    }
    walk(root, root, [], 0)
  }
  function structure(node: EditNode, parent?: EditNode) {
    const children = node.content ?? [], types = children.map(n => n.type)
    const block = (n: EditNode) => !inlines.has(n.type) && !['listItem', 'taskItem', 'layoutColumn', 'doc', 'tableRow', 'tableCell', 'tableHeader'].includes(n.type)
    let valid = true
    switch (node.type) {
      case 'doc': case 'blockquote': case 'layoutColumn': case 'listItem': case 'taskItem':
        valid = children.length > 0 && children.every(block)
        if (['listItem', 'taskItem'].includes(node.type)) valid &&= types[0] === 'paragraph'
        break
      case 'bulletList': case 'orderedList': valid = children.length > 0 && types.every(type => type === 'listItem'); break
      case 'taskList': valid = children.length > 0 && types.every(type => type === 'taskItem'); break
      case 'paragraph': case 'heading': valid = children.every(child => inlines.has(child.type) || (!blockTypes.has(child.type) && !writableSet.has(child.type) && child.type !== 'doc')); break
      case 'codeBlock': valid = children.every(child => child.type === 'text' && !child.marks?.length); break
      case 'horizontalRule': case 'hardBreak': case 'pageLink': valid = !children.length; break
      case 'text': valid = typeof node.text === 'string' && node.text.length > 0 && !children.length; break
      case 'layoutGroup': valid = parent?.type === 'doc' && children.length >= 2 && children.length <= 3 && types.every(type => type === 'layoutColumn') && [undefined, null, 'rtl', 'ltr'].includes(node.attrs?.direction as any); break
      default: protectedContent = true; return // opaque original subtree; never parsed or rewritten
    }
    if (node.type === 'layoutColumn' && parent?.type !== 'layoutGroup') valid = false
    if (node.type === 'heading' && node.attrs?.level !== undefined && !integer(node.attrs.level, 6)) valid = false
    if (!valid) fail('UNSUPPORTED_CONTENT')
    children.forEach(child => structure(child, node))
  }
  index(); structure(root)
  const fresh = () => { let id: string; do { id = `m1_${seed.slice(0, 32)}_${++serial}` } while (reserved.has(id)); reserved.add(id); return id }
  function resolve(ref: EditReference): Entry {
    reference(ref)
    const id = 'blockId' in ref ? ref.blockId : temporary.get(ref.temporaryId)
    const entry = id ? entries.get(id) : undefined
    if (!entry || entry.node === root) fail('INVALID_TARGET')
    return entry
  }
  function accessible(entry: Entry) {
    if (entry.ancestors.some(node => node !== root && !containers.has(node.type) && node.type !== 'layoutGroup')) fail('UNSUPPORTED_CONTENT')
  }
  function editable(node: EditNode) {
    if (!writableSet.has(node.type) && !inlines.has(node.type)) fail('UNSUPPORTED_CONTENT')
    if (node.marks?.some(mark => !marks.has(mark.type))) fail('UNSUPPORTED_CONTENT')
    node.content?.forEach(editable)
  }
  function selected(target: EditRange) {
    range(target)
    const first = resolve(target.from), last = resolve(target.through)
    accessible(first); accessible(last)
    if (first.parent !== last.parent || !containers.has(first.parent.type)) fail('INVALID_TARGET')
    const siblings = first.parent.content!, from = siblings.indexOf(first.node), through = siblings.indexOf(last.node)
    if (from > through) fail('INVALID_TARGET')
    const nodes = siblings.slice(from, through + 1); nodes.forEach(editable)
    return { parent: first.parent, from, nodes }
  }
  function destination(at: EditLocation) {
    location(at)
    if (at.position === 'end') {
      const entry = at.parent === null ? null : resolve(at.parent)
      if (entry) accessible(entry)
      const parent = entry?.node ?? root
      if (!containers.has(parent.type)) fail('INVALID_TARGET')
      return { parent, anchor: null, position: 'end' as const }
    }
    const anchor = resolve(at.target); accessible(anchor)
    if (!containers.has(anchor.parent.type)) fail('INVALID_TARGET')
    return { parent: anchor.parent, anchor: anchor.node, position: at.position }
  }
  function inserted(blocks: InsertedBlock[]) {
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100) fail('INVALID_ARGUMENT')
    function prepare(node: EditNode): EditNode {
      fields(node, ['type', 'text', 'attrs', 'marks', 'content'], ['type'])
      if (!writableSet.has(node.type) && !inlines.has(node.type)) fail('UNSUPPORTED_CONTENT')
      if (node.attrs !== undefined) {
        const allowed = node.type === 'pageLink' ? ['id', 'label'] : [...Object.keys(attributeTypes).filter(key => attributeTypes[key].includes(node.type)), ...(node.type === 'orderedList' ? ['start'] : [])]
        fields(node.attrs, allowed, [])
        const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key in attributeTypes))
        if (Object.keys(attrs).length) attributes(attrs)
        if (node.type === 'orderedList' && node.attrs.start !== undefined && !integer(node.attrs.start, Number.MAX_SAFE_INTEGER)) fail('INVALID_ARGUMENT')
      }
      if (node.type === 'pageLink') {
        if (!string(node.attrs?.id) || !string(node.attrs?.label, 512)) fail('INVALID_ARGUMENT')
        if (!runtime.canLink(node.attrs!.id as string)) fail('ACCESS_DENIED')
      }
      if (node.text !== undefined && (node.type !== 'text' || !string(node.text, LIMITS.textChars))) fail('INVALID_ARGUMENT')
      if (node.marks !== undefined) {
        if (node.type !== 'text' || !Array.isArray(node.marks) || node.marks.length > 5) fail('UNSUPPORTED_CONTENT')
        const seen = new Set<string>()
        for (const mark of node.marks) { fields(mark, ['type']); if (!marks.has(mark.type) || seen.has(mark.type)) fail('UNSUPPORTED_CONTENT'); seen.add(mark.type) }
        if (seen.has('code') && seen.size > 1) fail('UNSUPPORTED_CONTENT')
      }
      if (writableSet.has(node.type)) node.attrs = { ...node.attrs, blockId: fresh() }
      if (node.content !== undefined && !Array.isArray(node.content)) fail('INVALID_ARGUMENT')
      node.content?.forEach(prepare)
      return node
    }
    return blocks.map(item => {
      fields(item, ['temporaryId', 'node'])
      if (!isBlockId(item.temporaryId) || temporary.has(item.temporaryId)) fail('INVALID_ARGUMENT')
      const node = prepare(item.node)
      if (!writableSet.has(node.type)) fail('INVALID_ARGUMENT')
      temporary.set(item.temporaryId, node.attrs!.blockId as string)
      return node
    })
  }
  const ids = (nodes: EditNode[]): string[] => nodes.flatMap(node => [...(isBlockId(node.attrs?.blockId) ? [node.attrs.blockId] : []), ...ids(node.content ?? [])])
  const contains = (node: EditNode, target: EditNode): boolean => node === target || !!node.content?.some(child => contains(child, target))
  function changed(kind: Change['kind'], old: EditNode[], next: EditNode[], oldLocation?: unknown, nextLocation?: unknown) {
    const blockIds = [...new Set([...ids(old), ...ids(next)])]
    blockIds.forEach(id => affected.add(id))
    changes.push({ kind, blockIds, before: JSON.stringify(oldLocation ? { location: oldLocation, blocks: old } : old), after: JSON.stringify(nextLocation ? { location: nextLocation, blocks: next } : next) })
  }
  for (const operation of input.operations) {
    switch (operation?.kind) {
      case 'insert_blocks': {
        fields(operation, ['kind', 'at', 'blocks'])
        const dest = destination(operation.at), nodes = inserted(operation.blocks)
        const children = dest.parent.content ??= []
        children.splice(dest.anchor ? children.indexOf(dest.anchor) + (dest.position === 'after' ? 1 : 0) : children.length, 0, ...nodes)
        changed('insert', [], nodes); break
      }
      case 'replace_blocks': case 'delete_blocks': {
        fields(operation, operation.kind === 'replace_blocks' ? ['kind', 'target', 'blocks'] : ['kind', 'target'])
        const source = selected(operation.target), nodes = operation.kind === 'replace_blocks' ? inserted(operation.blocks) : []
        source.parent.content!.splice(source.from, source.nodes.length, ...nodes)
        changed(operation.kind === 'replace_blocks' ? 'replace' : 'delete', source.nodes, nodes); break
      }
      case 'move_blocks': {
        fields(operation, ['kind', 'target', 'at'])
        const source = selected(operation.target), dest = destination(operation.at)
        if (source.nodes.some(node => contains(node, dest.parent) || (dest.anchor && contains(node, dest.anchor)))) fail('INVALID_TARGET')
        const oldLocation = { parentBlockId: source.parent.attrs?.blockId ?? null, index: source.from }
        source.parent.content!.splice(source.from, source.nodes.length)
        const children = dest.parent.content ??= []
        children.splice(dest.anchor ? children.indexOf(dest.anchor) + (dest.position === 'after' ? 1 : 0) : children.length, 0, ...source.nodes)
        changed('move', source.nodes, source.nodes, oldLocation, { parentBlockId: dest.parent.attrs?.blockId ?? null, index: children.indexOf(source.nodes[0]) }); break
      }
      case 'set_attributes': case 'set_internal_link': {
        fields(operation, operation.kind === 'set_attributes' ? ['kind', 'target', 'attributes'] : ['kind', 'target', 'destinationDocumentId', 'label'])
        const entry = resolve(operation.target); accessible(entry); editable(entry.node)
        const node = entry.node, old = cloneDocumentValue(node)
        if (operation.kind === 'set_attributes') {
          attributes(operation.attributes)
          if (Object.keys(operation.attributes).some(key => !attributeTypes[key].includes(node.type))) fail('UNSUPPORTED_CONTENT')
          node.attrs = { ...node.attrs, ...operation.attributes }
        } else {
          if (!['paragraph', 'heading'].includes(node.type)) fail('INVALID_TARGET')
          if (!string(operation.destinationDocumentId) || !string(operation.label, 512)) fail('INVALID_ARGUMENT')
          if (!runtime.canLink(operation.destinationDocumentId)) fail('ACCESS_DENIED')
          // The contract addresses a whole block: replace its complete inline content, never guess a text span.
          node.content = [{ type: 'pageLink', attrs: { id: operation.destinationDocumentId, label: operation.label } }]
        }
        changed(operation.kind === 'set_attributes' ? 'attributes' : 'link', [old], [node]); break
      }
      default: fail('INVALID_ARGUMENT')
    }
    index()
  }
  structure(root) // whole final known structure, including temporarily emptied source containers
  let charsLeft = input.budget?.maxChars ?? LIMITS.textChars, blocksLeft = input.budget?.maxBlocks ?? 100, truncated = false
  const take = (text: string, max: number) => { const all = [...text], value = all.slice(0, max).join(''); if (all.length > max) truncated = true; return value }
  const bounded = changes.map(change => {
    const before = take(change.before, Math.min(4096, charsLeft)); charsLeft -= [...before].length
    const after = take(change.after, Math.min(4096, charsLeft)); charsLeft -= [...after].length
    const blockIds = change.blockIds.slice(0, blocksLeft); blocksLeft -= blockIds.length
    if (blockIds.length !== change.blockIds.length) truncated = true
    return { ...change, before, after, blockIds }
  })
  const preview: EditPreview = { mode: 'preview', documentId: before.id, baseRevision: input.expectedRevision, persisted: false, changes: bounded, truncated,
    warnings: protectedContent ? [{ code: 'UNSUPPORTED_CONTENT', message: 'Untouched content outside the writable profile is preserved.', blockIds: [] }] : [] }
  // Codepoint limits alone do not bound UTF-8 JSON (including escapes and IDs).
  while (bytes(JSON.stringify({ ok: true, result: preview })) > LIMITS.responseBytes) {
    const change = [...bounded].reverse().find(change => change.after.length || change.before.length)
    if (!change) fail('LIMIT_EXCEEDED')
    if (change.after) change.after = [...change.after].slice(0, Math.floor([...change.after].length / 2)).join('')
    else change.before = [...change.before].slice(0, Math.floor([...change.before].length / 2)).join('')
    preview.truncated = true
  }
  return { before, after, temporaryIds: Object.fromEntries(temporary), affectedBlockIds: [...affected], preview }
}
