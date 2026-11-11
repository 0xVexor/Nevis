/** HTTP contract for the authenticated Gin service. The caller owns credentials
 * and supplies the transport; no token is persisted by this client. */
export interface ImportManifest {
  documents: string[]
  attachments: string[]
  archive_id?: string
  fingerprints: Record<string, string>
  attachment_hashes: Record<string, string>
}

export interface DocumentMutation {
  key: string
  expected_revision: number
  metadata: Record<string, unknown>
  deleted: boolean
}

export interface VaultChange {
  seq: number
  id: string
  revision: number
  deleted: boolean
  metadata: Record<string, unknown>
}

export class ServerApiError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Server request failed (HTTP ${status})`)
    this.name = 'ServerApiError'
    this.status = status
  }
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/
const sha256 = /^[a-f0-9]{64}$/
function id(value: string): string {
  if (!identifier.test(value)) throw new Error('Invalid server identifier')
  return value
}
function originUrl(value: string): URL {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('Invalid server origin')
  return url
}
function uploadUrl(value: string): URL {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local)))
    throw new Error('Invalid attachment upload URL')
  return url
}
function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server response')
  return value as Record<string, unknown>
}
function responseId(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid server response')
  return value
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid server response')
  return value as number
}

/** Snapshot a complete manifest before the first request. Existing imports can
 * only be retried with the same document/attachment IDs and fingerprints. */
export function validateManifest(input: ImportManifest): ImportManifest {
  const manifest = structuredClone(input)
  if (!Array.isArray(manifest.documents) || !Array.isArray(manifest.attachments) || manifest.documents.length > 100000 || manifest.attachments.length > 100000)
    throw new Error('Invalid import manifest')
  const validateIds = (values: string[]) => {
    if (new Set(values).size !== values.length) throw new Error('Duplicate import identifier')
    values.forEach(id)
  }
  validateIds(manifest.documents)
  validateIds(manifest.attachments)
  if (manifest.archive_id) id(manifest.archive_id)
  const documentHashes = requireObject(manifest.fingerprints), attachmentHashes = requireObject(manifest.attachment_hashes)
  const attachmentIds = [...manifest.attachments, ...(manifest.archive_id ? [manifest.archive_id] : [])]
  if (manifest.archive_id && manifest.attachments.includes(manifest.archive_id)) throw new Error('Duplicate import identifier')
  if (Object.keys(documentHashes).length !== manifest.documents.length || Object.keys(attachmentHashes).length !== attachmentIds.length ||
      !manifest.documents.every(key => typeof documentHashes[key] === 'string' && sha256.test(documentHashes[key] as string)) ||
      !attachmentIds.every(key => typeof attachmentHashes[key] === 'string' && sha256.test(attachmentHashes[key] as string)))
    throw new Error('Invalid import fingerprints')
  return manifest
}

export class NevisServerApi {
  private readonly origin: URL
  private readonly token: string
  private readonly send: typeof fetch
  constructor(origin: string, token: string, send: typeof fetch = fetch) {
    this.origin = originUrl(origin)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid session token')
    this.token = token
    this.send = send
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.send(new URL(path, this.origin), {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit', redirect: 'error', signal,
    })
    if (!response.ok) throw new ServerApiError(response.status)
    return response
  }

  /** Check the active credential before resuming a vault-bound operation. */
  async verifyIdentity(expectedOrigin: string, expectedAccountId: string, signal?: AbortSignal): Promise<void> {
    if (originUrl(expectedOrigin).origin !== this.origin.origin) throw new Error('Server origin mismatch')
    id(expectedAccountId)
    const response = await this.request('GET', '/v1/account', undefined, signal)
    if (response.status !== 200 || responseId(requireObject(await response.json()).id) !== expectedAccountId) throw new Error('Server account mismatch')
  }

  async createVault(vaultId: string, name: string, signal?: AbortSignal): Promise<string> {
    id(vaultId)
    if (!name || new TextEncoder().encode(name).length > 200) throw new Error('Invalid vault name')
    const response = await this.request('POST', '/v1/vaults', { id: vaultId, name }, signal)
    if (response.status !== 201) throw new Error('Invalid server response')
    const returned = responseId(requireObject(await response.json()).id)
    if (returned !== vaultId) throw new Error('Unexpected server vault')
    return returned
  }

  async mutateDocument(vaultId: string, documentId: string, input: DocumentMutation, signal?: AbortSignal): Promise<{ id: string; revision: number; seq: number }> {
    id(vaultId); id(documentId); id(input.key)
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || typeof input.deleted !== 'boolean') throw new Error('Invalid document mutation')
    const mutation = structuredClone(input)
    requireObject(mutation.metadata)
    if (Object.hasOwn(mutation.metadata, 'doc') || new TextEncoder().encode(JSON.stringify(mutation.metadata)).length > 65536) throw new Error('Invalid document metadata')
    const response = await this.request('POST', `/v1/vaults/${vaultId}/documents/${documentId}`, mutation, signal)
    if (response.status !== 200) throw new Error('Invalid server response')
    const data = requireObject(await response.json())
    const result = { id: responseId(data.id), revision: revision(data.revision), seq: revision(data.seq) }
    if (result.id !== documentId || result.revision !== input.expected_revision + 1 || result.seq === 0) throw new Error('Invalid server response')
    return result
  }

  async changes(vaultId: string, since: number, signal?: AbortSignal): Promise<{ changes: VaultChange[]; next: number; hasMore: boolean }> {
    id(vaultId)
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid change cursor')
    const response = await this.request('GET', `/v1/vaults/${vaultId}/changes?since=${since}`, undefined, signal)
    if (response.status !== 200) throw new Error('Invalid server response')
    const data = requireObject(await response.json())
    if (!Array.isArray(data.changes) || data.changes.length > 500 || typeof data.has_more !== 'boolean') throw new Error('Invalid server response')
    let last = since
    const changes = data.changes.map((value): VaultChange => {
      const row = requireObject(value)
      const seq = revision(row.seq), rowRevision = revision(row.revision)
      if (seq <= last || rowRevision === 0 || typeof row.deleted !== 'boolean') throw new Error('Invalid server response')
      last = seq
      return { seq, id: responseId(row.id), revision: rowRevision, deleted: row.deleted, metadata: requireObject(row.metadata) }
    })
    const next = revision(data.next)
    if (next !== last || data.has_more !== (changes.length === 500)) throw new Error('Invalid server response')
    return { changes, next, hasMore: data.has_more }
  }

  async beginImport(vaultId: string, input: ImportManifest, signal?: AbortSignal): Promise<string> {
    id(vaultId)
    const manifest = validateManifest(input)
    if (new TextEncoder().encode(JSON.stringify(manifest)).length > 2 * 1024 * 1024) throw new Error('Import manifest exceeds the server limit')
    const response = await this.request('POST', `/v1/vaults/${vaultId}/import`, manifest, signal)
    if (response.status !== 201) throw new Error('Invalid server response')
    return responseId(requireObject(await response.json()).id)
  }

  async importStatus(vaultId: string, signal?: AbortSignal): Promise<{ id: string; status: 'uploading' | 'complete'; manifest: ImportManifest }> {
    id(vaultId)
    const response = await this.request('GET', `/v1/vaults/${vaultId}/import`, undefined, signal)
    if (response.status !== 200) throw new Error('Invalid server response')
    const data = requireObject(await response.json())
    if (data.status !== 'uploading' && data.status !== 'complete') throw new Error('Invalid server response')
    return { id: responseId(data.id), status: data.status, manifest: validateManifest(data.manifest as ImportManifest) }
  }

  async completeImport(vaultId: string, signal?: AbortSignal): Promise<void> {
    id(vaultId)
    const response = await this.request('POST', `/v1/vaults/${vaultId}/import/complete`, undefined, signal)
    if (response.status !== 204) throw new Error('Invalid server response')
  }

  async beginAttachment(documentId: string, hash: string, size: number, key: string, signal?: AbortSignal): Promise<{ id: string; ready: true } | { id: string; ready: false; uploadUrl: string; expiresIn: number }> {
    id(documentId); id(key)
    if (!sha256.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error('Invalid attachment')
    const response = await this.request('POST', `/v1/documents/${documentId}/attachments`, { sha256: hash, size, key }, signal)
    const data = requireObject(await response.json())
    if (response.status === 200 && data.ready === true) return { id: responseId(data.id), ready: true }
    if (response.status !== 201) throw new Error('Invalid server response')
    if (typeof data.upload_url !== 'string' || !Number.isSafeInteger(data.expires_in) || (data.expires_in as number) <= 0 || (data.expires_in as number) > 60)
      throw new Error('Invalid server response')
    uploadUrl(data.upload_url)
    return { id: responseId(data.id), ready: false, uploadUrl: data.upload_url, expiresIn: data.expires_in as number }
  }

  async completeAttachment(documentId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    id(documentId); id(attachmentId)
    const response = await this.request('POST', `/v1/documents/${documentId}/attachments/${attachmentId}/complete`, undefined, signal)
    if (response.status !== 204) throw new Error('Invalid server response')
  }
}

/** Upload only the verified bytes. The transport must send their exact Content-Length;
 * do not attach the device session to a signed storage URL. */
export async function uploadAttachment(
  signedUrl: string, source: Uint8Array, expectedHash: string, send: typeof fetch = fetch, signal?: AbortSignal,
): Promise<void> {
  const url = uploadUrl(signedUrl)
  const bytes = new Uint8Array(source)
  if (!sha256.test(expectedHash) || bytes.byteLength > 64 * 1024 * 1024) throw new Error('Invalid attachment')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedHash) throw new Error('Attachment hash mismatch')
  const response = await send(url, { method: 'PUT', body: bytes, credentials: 'omit', redirect: 'error', signal })
  if (!response.ok) throw new ServerApiError(response.status)
}
