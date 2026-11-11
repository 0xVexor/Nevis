import { documentResources } from '../documents/admission.ts'
import type { Page } from '../documents/model.ts'
import { assertVerifiedMigrationBackup } from './verifiedBackup.ts'
import type { VerifiedMigrationBackup } from './verifiedBackup.ts'

export interface AttachmentPlan {
  references: { documentId: string; sha256: string }[]
  unreferenced: string[]
  unsupportedDocuments: string[]
}

/** Never guess a document association for an orphan: that could expose the
 * attachment through a document that is later shared. */
export function planBackupAttachments(backup: VerifiedMigrationBackup, vaultId: string, pagesInput: readonly Page[]): AttachmentPlan {
  const pages = structuredClone(pagesInput)
  assertVerifiedMigrationBackup(backup, vaultId, pages, backup.attachmentIds)
  const available = new Set(backup.attachmentIds), referenced = new Set<string>()
  const references: AttachmentPlan['references'] = [], unsupportedDocuments: string[] = []
  for (const page of pages) {
    const resources = documentResources(page)
    // Database and slide payloads need their own resource and conversion rules.
    if (page.kind === 'deck' || page.database || page.dbHost || [...resources].some(value => value.startsWith('database:'))) unsupportedDocuments.push(page.id)
    for (const resource of resources) {
      if (!resource.startsWith('attachment:')) continue
      const sha256 = resource.slice('attachment:'.length)
      if (!/^[a-f0-9]{64}$/.test(sha256) || !available.has(sha256)) throw new Error(`Document ${page.id} references a missing attachment`)
      referenced.add(sha256)
      references.push({ documentId: page.id, sha256 })
    }
  }
  const sortText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  references.sort((a, b) => sortText(a.documentId, b.documentId) || sortText(a.sha256, b.sha256))
  return { references, unreferenced: [...available].filter(id => !referenced.has(id)).sort(sortText), unsupportedDocuments: unsupportedDocuments.sort(sortText) }
}
