// Outbox entries and external adapters. Credentials never live in the Vault: an entry references a connection id and the adapter
// resolves the secret from the OS credential store (desktop) or the gateway secret store (hosted).
import type { Id, Json } from '../model/types.ts'

export type OutboxState = 'queued' | 'retry' | 'succeeded' | 'failed' | 'paused' | 'uncertain'

export type OutboxEntry = {
  id: Id
  runKey: string
  actionIndex: number
  type: string
  connectionId: Id | null
  payload: Json
  state: OutboxState
  attempt: number
  retryAt: number | null
  idempotencyKey: string
  error?: string
}

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; retryAfterMs?: number; code?: 'MISSING_CREDENTIALS' | 'PROVIDER_UNAVAILABLE' | 'UNCERTAIN'; message: string }

export interface ExternalAdapter {
  type: string
  /** false = the provider cannot deduplicate: an uncertain outcome is held for review, never blindly resent */
  supportsIdempotency: boolean
  send(req: { entry: OutboxEntry; idempotencyKey: string }): Promise<SendResult>
}
