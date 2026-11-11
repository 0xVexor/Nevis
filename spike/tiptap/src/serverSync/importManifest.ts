import { initializationFingerprint } from './encodeInitialDocument.ts'
import { validateManifest } from './api.ts'
import type { ImportManifest } from './api.ts'
import { canonicalDocumentValue } from '../documents/revision.ts'

/** The server represents an omitted archive as an empty string when returning
 * the manifest. Array order remains significant to its retry comparison. */
export function assertSameImport(expected: ImportManifest, actual: ImportManifest): void {
  const normalize = (value: ImportManifest) => {
    const validated = validateManifest(value)
    return { ...validated, archive_id: validated.archive_id || '' }
  }
  if (canonicalDocumentValue(normalize(expected)) !== canonicalDocumentValue(normalize(actual))) throw new Error('Import manifest mismatch')
}

/** IDs and bytes must come from durable preparation/reservation records, not
 * newly generated Yjs documents or newly reserved uploads on every retry. */
export async function buildImportManifest(
  documents: { id: string; initialUpdate: Uint8Array }[],
  attachments: { id: string; sha256: string }[],
  archive?: { id: string; sha256: string },
): Promise<ImportManifest> {
  if (documents.length > 100000 || attachments.length > 100000) throw new Error('Invalid import manifest')
  // Freeze caller-owned data before yielding while computing the hashes.
  const order = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  const prepared = documents.map(document => ({ id: document.id, update: new Uint8Array(document.initialUpdate) })).sort(order)
  const assets = attachments.map(attachment => ({ ...attachment })).sort(order)
  const archiveCopy = archive && { ...archive }
  const pairs = await Promise.all(prepared.map(async document => [document.id, await initializationFingerprint(document.update)] as const))
  const manifest: ImportManifest = {
    documents: prepared.map(document => document.id),
    attachments: assets.map(attachment => attachment.id),
    fingerprints: Object.fromEntries(pairs),
    attachment_hashes: Object.fromEntries([...assets, ...(archiveCopy ? [archiveCopy] : [])].map(asset => [asset.id, asset.sha256])),
    ...(archiveCopy ? { archive_id: archiveCopy.id } : {}),
  }
  return validateManifest(manifest)
}
