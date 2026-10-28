import { BLOCK_TYPES, isBlockId, identityVersion } from './blockIdentity.ts'
import { cloneDocumentValue } from './clone.ts'
import { CONTRACT_VERSION, LIMITS } from './contracts.ts'
import { EDIT_CAPABILITIES } from './editPlanner.ts'
import type { EditNode } from './editPlanner.ts'
import type { Page } from './model.ts'
import type { DocumentOperationReceipt } from './operations.ts'
import type { DocumentMetadata } from './mutations.ts'

export type SyncState = 'pending' | 'synced' | 'failed' | 'disabled'
export type SavedSearch = { state: 'fresh' | 'pending' | 'failed'; indexedRevision: string | null }
type Chunk = { range: { fromBlockId: string; throughBlockId: string }; markdown: null; structured: EditNode[] }
export interface SavedEditEvidence {
  metadata?: DocumentMetadata
  affectedBlockIds: string[]
  savedContent: {
    documentId: string; revision: string
    capabilities: { contractVersion: '1'; blockIdentity: 'stable'; readableNodeTypes: string[]; writableNodeTypes: string[]; writableMarks: string[]; writableAttributes: string[]; operations: string[]; preservesUntouchedUnsupportedNodes: boolean }
    chunks: Chunk[]; nextCursor: null; truncated: boolean
    warnings: { code: 'UNSUPPORTED_CONTENT'; message: string; blockIds: string[] }[]
  }
}
export function savedEditResult(receipt: DocumentOperationReceipt, evidence: SavedEditEvidence, search: SavedSearch, sync: SyncState, replayed: boolean) {
  return { documentId: receipt.documentId, revision: receipt.revision,
    receipt: { operationId: receipt.operationId, documentId: receipt.documentId, beforeRevision: receipt.beforeRevision,
      afterRevision: receipt.revision, committedAt: receipt.committedAt, undoExpiresAt: null },
    ...cloneDocumentValue(evidence), search, sync, replayed }
}
const bytes = (s: string) => { let n = 0; for (const c of s) { const cp = c.codePointAt(0)!; n += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4 } return n }
/** Prepare bounded evidence BEFORE persistence. Large blocks are omitted whole, never silently cut. */
export function savedEditEvidence(page: Page, receipt: DocumentOperationReceipt, affectedBlockIds: string[], budget = { maxChars: 8000, maxBlocks: 50 }, metadata?: DocumentMetadata): SavedEditEvidence {
  const evidence: SavedEditEvidence = { ...(metadata ? { metadata: cloneDocumentValue(metadata) } : {}), affectedBlockIds: [...affectedBlockIds], savedContent: {
    documentId: page.id, revision: receipt.revision, capabilities: { contractVersion: CONTRACT_VERSION, blockIdentity: 'stable',
      readableNodeTypes: [...BLOCK_TYPES, 'text', 'hardBreak', 'pageLink', 'mathInline', 'inlineIcon'], ...cloneDocumentValue(EDIT_CAPABILITIES) },
    chunks: [], warnings: [], nextCursor: null, truncated: false,
  } }
  if (page.kind === 'folder' || identityVersion(page.content) !== 1 || page.content?.type !== 'doc') {
    Object.assign(evidence.savedContent.capabilities, { writableNodeTypes: [], writableMarks: [], writableAttributes: [], operations: [] })
  }
  const fits = () => bytes(JSON.stringify({ ok: true, result: { mode: 'apply', saved: savedEditResult(receipt, evidence,
    { state: 'fresh', indexedRevision: receipt.revision }, 'disabled', false) } })) <= LIMITS.responseBytes - 128
  if (!fits()) throw new Error('Saved edit evidence limit exceeded')
  const affected = new Set(affectedBlockIds), selected: EditNode[] = []
  const pick = (node: EditNode) => {
    if (isBlockId(node.attrs?.blockId) && affected.has(node.attrs.blockId)) selected.push(node)
    else node.content?.forEach(pick)
  }
  if (affected.size) page.content.content.forEach(pick)
  let chars = 0, blocks = 0
  for (const node of selected) {
    let count = 0
    const inspect = (part: EditNode) => { if (isBlockId(part.attrs?.blockId)) count++; part.content?.forEach(inspect) }
    inspect(node)
    const size = [...JSON.stringify([node])].length
    if (blocks + count > budget.maxBlocks || chars + size > budget.maxChars || evidence.savedContent.chunks.length >= 100) { evidence.savedContent.truncated = true; break }
    const blockId = node.attrs!.blockId as string
    evidence.savedContent.chunks.push({ range: { fromBlockId: blockId, throughBlockId: blockId }, markdown: null, structured: [cloneDocumentValue(node)] })
    if (!fits()) { evidence.savedContent.chunks.pop(); evidence.savedContent.truncated = true; break }
    blocks += count; chars += size
  }
  return evidence
}
