// Reference parsing without network: which provider a pasted link belongs to, and its stable external id. Used by cell validation so
// the domain never accepts a connected value for a host it cannot identify.
import type { ProviderId } from './types.ts'
import { CONNECTED } from './connected.ts'

const OFFLINE = {
  fetchImpl: (() => { throw new Error('offline: references are only parsed here') }) as unknown as typeof fetch,
  credentials: { token: '' },
}

export interface ParsedReference { provider: ProviderId; externalId: string; canonicalUrl: string }

export function parseReference(input: string, only?: string): ParsedReference | null {
  for (const [id, make] of Object.entries(CONNECTED)) {
    if (only && id !== only) continue
    try {
      const r = make(OFFLINE).validateReference(input)
      return { provider: id as ProviderId, ...r }
    } catch { /* not this provider */ }
  }
  return null
}
