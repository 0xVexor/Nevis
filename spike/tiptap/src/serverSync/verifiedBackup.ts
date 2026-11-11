import type { Page } from '../documents/model.ts'
import { canonicalDocumentValue } from '../documents/revision.ts'

const verified = new WeakMap<object, { vaultId: string; pages: string; pageIds: Set<string>; attachments: string[]; data: Map<string, Uint8Array> }>()
const limit = 512 * 1024 * 1024
const pageId = /^[A-Za-z0-9_-]{1,80}$/
const hashPattern = /^[a-f0-9]{64}$/

export interface VerifiedMigrationBackup {
  readonly vaultId: string
  readonly sha256: string
  readonly pages: readonly Page[]
  readonly attachmentIds: readonly string[]
}

async function hash(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid migration backup')
  return value as Record<string, unknown>
}
function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Invalid backup entry encoding')
  const decoded = atob(value), out = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i)
  return out
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('Invalid backup JSON') }
}
function validatePages(values: unknown[]): Page[] {
  const ids = new Set<string>()
  const pages = values.map(value => {
    const page = object(value)
    if (typeof page.id !== 'string' || !pageId.test(page.id) || ids.has(page.id) || typeof page.title !== 'string' || !Object.hasOwn(page, 'content'))
      throw new Error('Invalid backup page')
    ids.add(page.id)
    return page as unknown as Page
  })
  for (const page of pages) if (page.parentId !== null && page.parentId !== undefined && (typeof page.parentId !== 'string' || !ids.has(page.parentId)))
    throw new Error('Backup page parent is missing')
  return pages
}

/** The caller writes `bytes` to the chosen backup destination and independently
 * reads it back. A normal browser download cannot provide this guarantee. */
export async function verifySavedMigrationBackup(
  expectedVaultId: string,
  bytes: Uint8Array,
  readBack: Uint8Array,
): Promise<VerifiedMigrationBackup> {
  if (!expectedVaultId || !bytes.length || bytes.length > limit * 2 || bytes.length !== readBack.length) throw new Error('Invalid migration backup')
  const source = new Uint8Array(bytes), saved = new Uint8Array(readBack)
  const fingerprint = await hash(source)
  if (await hash(saved) !== fingerprint) throw new Error('Saved backup verification failed')
  const root = object(parseJson(saved))
  let pages: Page[], attachmentIds: string[]
  const attachmentData = new Map<string, Uint8Array>()
  if (root.format === 'nevis-vault-backup' && root.version === 2) {
    const entries = object(root.entries), decoded = new Map<string, Uint8Array>()
    let total = 0
    for (const [path, raw] of Object.entries(entries)) {
      const segments = path.split('/')
      if (path.includes('\\') || path.includes(':') || segments.some(part => !part || part === '.' || part === '..' || part.endsWith('.tmp')) ||
          !(path === '.nevis/vault.json' || ['pages/', 'files/', 'databases/', 'kv/', 'history/', 'conflicts/', '.trash/'].some(prefix => path.startsWith(prefix))))
        throw new Error('Unsafe backup path')
      const entry = object(raw), data = decodeBase64(entry.data)
      total += data.byteLength
      if (total > limit || typeof entry.sha256 !== 'string' || !hashPattern.test(entry.sha256) || await hash(data) !== entry.sha256)
        throw new Error('Backup entry verification failed')
      if (path.endsWith('.json')) parseJson(data)
      decoded.set(path, data)
    }
    const marker = decoded.get('.nevis/vault.json')
    if (!marker || object(parseJson(marker)).id !== expectedVaultId) throw new Error('Backup vault mismatch')
    const values: unknown[] = []
    for (const [path, data] of decoded) {
      const match = /^pages\/([A-Za-z0-9_-]{1,80})\.json$/.exec(path)
      if (path.startsWith('pages/') && !match) throw new Error('Invalid backup page path')
      if (match) {
        const page = object(parseJson(data))
        if (page.id !== match[1]) throw new Error('Invalid backup page identity')
        values.push(page)
      }
    }
    pages = validatePages(values)
    attachmentIds = []
    for (const [path, data] of decoded) {
      const match = /^files\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(path)
      if (path.startsWith('files/') && !match && !/^files\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(path)) throw new Error('Invalid backup attachment path')
      if (!match) continue
      const sidecar = decoded.get(`${path}.json`)
      if (match[1] !== match[2].slice(0, 2) || await hash(data) !== match[2] || !sidecar) throw new Error('Invalid backup attachment')
      const metadata = object(parseJson(sidecar))
      if (metadata.id !== match[2] || metadata.size !== data.byteLength) throw new Error('Invalid backup attachment metadata')
      attachmentIds.push(match[2])
      attachmentData.set(match[2], data)
    }
    for (const path of decoded.keys()) if (/^files\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(path) && !decoded.has(path.slice(0, -5)))
      throw new Error('Backup attachment is missing')
  } else {
    // The portable web format has no vault identity; do not treat it as proof
    // for a native vault until a separately bound browser-vault flow exists.
    throw new Error('Unsupported migration backup format')
  }
  const result: VerifiedMigrationBackup = Object.freeze({
    vaultId: expectedVaultId,
    sha256: fingerprint,
    pages: Object.freeze(structuredClone(pages)),
    attachmentIds: Object.freeze(attachmentIds.sort()),
  })
  verified.set(result, { vaultId: expectedVaultId, pages: canonicalDocumentValue([...pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), pageIds: new Set(pages.map(page => page.id)), attachments: [...attachmentIds], data: attachmentData })
  return result
}

/** Read only bytes that were verified as part of this exact backup. */
export function readVerifiedBackupAttachment(backup: VerifiedMigrationBackup, vaultId: string, documentId: string, attachmentHash: string): Uint8Array {
  const proof = verified.get(backup)
  if (!proof || proof.vaultId !== vaultId || !proof.pageIds.has(documentId)) throw new Error('A verified backup for this vault and document is required')
  const bytes = proof.data.get(attachmentHash)
  if (!bytes) throw new Error('Attachment is missing from verified backup')
  return new Uint8Array(bytes)
}

export function assertVerifiedMigrationBackup(backup: VerifiedMigrationBackup, vaultId: string, pages: readonly Page[], attachmentHashes: readonly string[]): void {
  const proof = verified.get(backup)
  if (!proof || proof.vaultId !== vaultId) throw new Error('A verified backup for this vault is required')
  const sorted = (value: readonly Page[]) => [...value].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (proof.pages !== canonicalDocumentValue(sorted(pages))) throw new Error('Import does not match verified backup pages')
  const expected = new Set(proof.attachments), actual = new Set(attachmentHashes)
  if (expected.size !== actual.size || [...expected].some(hash => !actual.has(hash))) throw new Error('Import does not match verified backup attachments')
}
