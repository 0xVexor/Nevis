/** The server fingerprints the exact update bytes, so callers must durably retain
 * these bytes before calling and reuse them after an interrupted request. */
export interface BootstrapRequest {
  collaborationOrigin: string
  documentId: string
  sessionToken: string
  initialUpdate: Uint8Array
  signal?: AbortSignal
}

export class BootstrapError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Document initialization failed (HTTP ${status})`)
    this.name = 'BootstrapError'
    this.status = status
  }
}

export async function bootstrapDocument(input: BootstrapRequest, send: typeof fetch = fetch): Promise<void> {
  const origin = new URL(input.collaborationOrigin)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid collaboration origin')
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) throw new Error('Collaboration origin must use HTTPS')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.documentId)) throw new Error('Invalid document ID')
  if (!input.sessionToken || /[\r\n]/.test(input.sessionToken)) throw new Error('Invalid session token')
  if (!input.initialUpdate.byteLength || input.initialUpdate.byteLength > 2 * 1024 * 1024) throw new Error('Invalid initialization size')

  // Copy caller-owned memory so it cannot change while the request is in flight.
  const body = new Uint8Array(input.initialUpdate)
  const response = await send(new URL(`/v1/documents/${input.documentId}/bootstrap`, origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.sessionToken}`, 'Content-Type': 'application/octet-stream' },
    body,
    redirect: 'error',
    credentials: 'omit',
    signal: input.signal,
  })
  // The service reports a generic 409 for several failures; do not infer a
  // fingerprint conflict or mark an ambiguous failure as initialized.
  if (response.status !== 201) throw new BootstrapError(response.status)
}
