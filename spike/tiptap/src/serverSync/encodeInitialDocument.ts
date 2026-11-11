import type { Schema } from '@tiptap/pm/model'
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { canonicalDocumentValue } from '../documents/revision.ts'
import type { Page } from '../documents/model.ts'
import type { InitializationScope } from './initializationStore.ts'

/** Import manifests use the server's lowercase SHA-256 of the exact update bytes. */
export async function initializationFingerprint(update: Uint8Array): Promise<string> {
  if (!update.byteLength || update.byteLength > 2 * 1024 * 1024) throw new Error('Invalid initialization size')
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(update))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Yjs' XML fragment stores the doc children, not the ProseMirror root attributes. */
export function readInitialDocument(ydoc: Y.Doc, schema: Schema): unknown {
  const content = yDocToProsemirrorJSON(ydoc, 'default')
  const attrs = ydoc.getMap('nevis:document').get('attrs')
  // Yjs omits null XML attributes; the editor schema restores their defaults.
  const document = schema.nodeFromJSON(attrs === undefined ? content : { ...content, attrs })
  document.check()
  return document.toJSON()
}

/** Reject any content the current editor or the Yjs binding would rewrite.
 * Never initialize an existing remote document with this newly generated state. */
export function encodeInitialDocument(schema: Schema, page: Page): Uint8Array {
  if (!page.content || typeof page.content !== 'object' || Array.isArray(page.content) || page.content.type !== 'doc')
    throw new Error('Document content requires conversion before sync')
  const original = canonicalDocumentValue(page.content)
  let document
  try {
    document = schema.nodeFromJSON(page.content)
    if (document.type !== schema.topNodeType) throw new Error('Invalid document root')
    document.check()
  } catch {
    throw new Error('Document contains content unsupported by the editor schema')
  }
  if (canonicalDocumentValue(document.toJSON()) !== original) throw new Error('Document would change during editor conversion')
  const ydoc = prosemirrorToYDoc(document, 'default')
  try {
    const root = document.toJSON()
    if (root.attrs) ydoc.getMap('nevis:document').set('attrs', structuredClone(root.attrs))
    const bytes = Y.encodeStateAsUpdate(ydoc)
    if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw new Error('Document initialization exceeds the server limit')
    const recovered = new Y.Doc()
    try {
      Y.applyUpdate(recovered, bytes)
      if (canonicalDocumentValue(readInitialDocument(recovered, schema)) !== original)
        throw new Error('Document would change during Yjs conversion')
    } finally { recovered.destroy() }
    return bytes
  } finally { ydoc.destroy() }
}

/** Preparing the record checks the saved page under the storage transaction or lock.
 * The remote import must retain this exact update and fingerprint for every retry. */
export async function prepareInitialDocument(
  schema: Schema,
  page: Page,
  scope: InitializationScope,
  store: { load(scope: InitializationScope): Promise<Uint8Array | null>; prepare(scope: InitializationScope, update: Uint8Array, expectedPage: Page): Promise<Uint8Array> },
): Promise<Uint8Array> {
  if (page.id !== scope.documentId) throw new Error('Initialization document mismatch')
  const snapshot = structuredClone(page)
  const boundScope = { ...scope }
  const existing = await store.load(boundScope)
  if (existing) {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, existing)
      if (canonicalDocumentValue(readInitialDocument(doc, schema)) !== canonicalDocumentValue(snapshot.content))
        throw new Error('Retained initialization does not match source page')
    } finally { doc.destroy() }
    // Recheck the saved page even on a retry; local changes need reconciliation
    // before the old initialization can safely be imported.
    return store.prepare(boundScope, existing, snapshot)
  }
  const bytes = encodeInitialDocument(schema, snapshot)
  return store.prepare(boundScope, bytes, snapshot)
}
