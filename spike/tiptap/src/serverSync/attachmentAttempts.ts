import { initializationKey } from './initializationStore.ts'
import type { ImportScope } from './importCheckpoint.ts'
import { ReservationExpiredError, transferBackupAttachment } from './transferAttachment.ts'
import { readVerifiedBackupAttachment } from './verifiedBackup.ts'

export interface AttachmentAttemptScope { scope: ImportScope; backupSha256: string; documentId: string; sha256: string }
export interface AttachmentAttempt { attempt: number; readyId: string | null }

function attemptKey(input: AttachmentAttemptScope): string {
  const { scope, backupSha256, documentId, sha256 } = input
  const binding = initializationKey({ ...scope, documentId })
  const origin = new URL(scope.apiOrigin)
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && local)))
    throw new Error('Invalid server origin')
  if (!/^[a-f0-9]{64}$/.test(backupSha256) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid attachment scope')
  return `server-sync/attachment-attempt/${JSON.stringify([binding, origin.origin, backupSha256, sha256])}`
}
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error ?? new Error('Attachment attempt transaction aborted'))
  tx.onerror = () => reject(tx.error ?? new Error('Attachment attempt transaction failed'))
})

/** Persists the generation before any request; signed URLs and tokens are never stored. */
export class IndexedDbAttachmentAttemptStore {
  private databaseName: string | null = null
  private readonly vaultId: string
  private readonly open: () => Promise<IDBDatabase>
  private readonly active: () => boolean
  constructor(vaultId: string, open: () => Promise<IDBDatabase>, active: () => boolean = () => true) {
    if (!vaultId) throw new Error('A fixed vault is required')
    this.vaultId = vaultId; this.open = open; this.active = active
  }
  async current(input: AttachmentAttemptScope): Promise<AttachmentAttempt> { return this.change(input) }
  /** Call only for a definite 410 from the reservation endpoint. Concurrent
   * callers that observed the same expired attempt share the next generation. */
  async expired(input: AttachmentAttemptScope, observed: number): Promise<AttachmentAttempt> {
    if (!Number.isSafeInteger(observed) || observed < 0 || observed === Number.MAX_SAFE_INTEGER) throw new Error('Invalid attachment attempt')
    return this.change(input, observed)
  }
  async ready(input: AttachmentAttemptScope, observed: number, readyId: string): Promise<AttachmentAttempt> {
    if (!Number.isSafeInteger(observed) || observed < 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(readyId)) throw new Error('Invalid attachment result')
    return this.change(input, undefined, { observed, readyId })
  }
  private async change(input: AttachmentAttemptScope, expired?: number, result?: { observed: number; readyId: string }): Promise<AttachmentAttempt> {
    const frozen = structuredClone(input), key = attemptKey(frozen)
    if (frozen.scope.vaultId !== this.vaultId || !this.active()) throw new Error('Attachment vault unavailable')
    const db = await this.open()
    if (!this.active() || (this.databaseName !== null && db.name !== this.databaseName)) throw new Error('Attachment vault unavailable')
    this.databaseName = db.name
    const tx = db.transaction('kv', 'readwrite', { durability: 'strict' }), done = completed(tx)
    const store = tx.objectStore('kv'), request = store.get(key)
    let output: AttachmentAttempt | undefined, failure: unknown
    request.onsuccess = () => {
      try {
        if (!this.active()) throw new Error('Attachment vault unavailable')
        const raw: unknown = request.result === undefined ? { attempt: 0, readyId: null } : request.result
        // Earlier local development stored only the generation number.
        const prior = typeof raw === 'number' ? { attempt: raw, readyId: null } : raw as AttachmentAttempt
        if (!prior || !Number.isSafeInteger(prior.attempt) || prior.attempt < 0 || (prior.readyId !== null && (typeof prior.readyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(prior.readyId))))
          throw new Error('Invalid saved attachment attempt')
        if (expired !== undefined && expired > prior.attempt) throw new Error('Attachment attempt mismatch')
        if (result && (result.observed !== prior.attempt || (prior.readyId !== null && prior.readyId !== result.readyId))) throw new Error('Attachment attempt mismatch')
        output = result ? { ...prior, readyId: result.readyId } : expired === prior.attempt && prior.readyId === null ? { attempt: prior.attempt + 1, readyId: null } : prior
        store.put(output, key)
      } catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    if (!this.active() || output === undefined) throw new Error('Attachment vault unavailable')
    return structuredClone(output)
  }
}

/** Retries a definitively expired reservation with a newly persisted generation;
 * ambiguous network, upload and completion failures keep the same generation. */
export async function transferWithStoredAttempt(
  input: Omit<Parameters<typeof transferBackupAttachment>[0], 'attempt'>,
  store: Pick<IndexedDbAttachmentAttemptStore, 'current' | 'expired' | 'ready'>,
): Promise<{ id: string; sha256: string }> {
  const key = { scope: structuredClone(input.scope), backupSha256: input.backup.sha256, documentId: input.documentId, sha256: input.sha256 }
  readVerifiedBackupAttachment(input.backup, key.scope.vaultId, key.documentId, key.sha256)
  await input.api.verifyIdentity(key.scope.apiOrigin, key.scope.accountId, input.signal)
  let state = await store.current(key)
  for (let expired = 0; expired < 3; expired++) {
    if (state.readyId) return { id: state.readyId, sha256: key.sha256 }
    try {
      const result = await transferBackupAttachment({ ...input, scope: key.scope, documentId: key.documentId, sha256: key.sha256, attempt: state.attempt })
      await store.ready(key, state.attempt, result.id)
      return result
    }
    catch (error) {
      if (!(error instanceof ReservationExpiredError)) throw error
      state = await store.expired(key, state.attempt)
    }
  }
  throw new Error('Attachment reservations repeatedly expired')
}
