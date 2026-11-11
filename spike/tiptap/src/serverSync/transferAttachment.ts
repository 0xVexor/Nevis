import { ServerApiError, uploadAttachment } from './api.ts'
import { readVerifiedBackupAttachment } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'
import type { ImportScope } from './importCheckpoint.ts'

interface AttachmentApi {
  verifyIdentity(origin: string, accountId: string, signal?: AbortSignal): Promise<void>
  beginAttachment(documentId: string, hash: string, size: number, key: string, signal?: AbortSignal): Promise<{ id: string; ready: true } | { id: string; ready: false; uploadUrl: string; expiresIn: number }>
  completeAttachment(documentId: string, attachmentId: string, signal?: AbortSignal): Promise<void>
}
export class ReservationExpiredError extends Error {
  constructor() { super('Attachment reservation expired'); this.name = 'ReservationExpiredError' }
}

/** Retry with the same attempt after any ambiguous response. Increment only
 * after a definite 410, and persist the new attempt before calling again. The
 * remote document metadata must already exist. No signed URL is persisted. */
export async function transferBackupAttachment(input: {
  scope: ImportScope
  backup: VerifiedMigrationBackup
  documentId: string
  sha256: string
  attempt: number
  api: AttachmentApi
  send?: typeof fetch
  signal?: AbortSignal
}): Promise<{ id: string; sha256: string }> {
  const scope = structuredClone(input.scope), documentId = input.documentId, sha256 = input.sha256, attempt = input.attempt
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Invalid attachment attempt')
  const bytes = readVerifiedBackupAttachment(input.backup, scope.vaultId, documentId, sha256)
  const identity = JSON.stringify([scope.vaultId, scope.accountId, new URL(scope.apiOrigin).origin, documentId, sha256, input.backup.sha256, attempt])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  const key = `a_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  await input.api.verifyIdentity(scope.apiOrigin, scope.accountId, input.signal)
  let reservation
  try { reservation = await input.api.beginAttachment(documentId, sha256, bytes.length, key, input.signal) }
  catch (error) {
    // A storage PUT might also return 410; only the API's reservation result
    // proves that its idempotency key has expired.
    if (error instanceof ServerApiError && error.status === 410) throw new ReservationExpiredError()
    throw error
  }
  if (!reservation.ready) {
    await uploadAttachment(reservation.uploadUrl, bytes, sha256, input.send, input.signal)
    await input.api.completeAttachment(documentId, reservation.id, input.signal)
  }
  return { id: reservation.id, sha256 }
}
