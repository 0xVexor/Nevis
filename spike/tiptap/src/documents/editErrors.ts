import { DocumentAssetError } from './assets.ts'
import { DocumentPlanError } from './editPlanner.ts'
import type { ERROR_CODES } from './contracts.ts'

export type EditCode = typeof ERROR_CODES[number]
export class DocumentEditError extends Error {
  readonly code: EditCode
  readonly retryable: boolean
  constructor(code: EditCode) { super(code.replaceAll('_', ' ').toLowerCase()); this.code = code; this.retryable = ['EDITOR_BUSY', 'APP_UNAVAILABLE'].includes(code) }
}
export function failEdit(code: EditCode): never { throw new DocumentEditError(code) }
export function translateEdit(error: unknown, fallback: EditCode): never {
  if (error instanceof DocumentEditError) throw error
  if (error instanceof DocumentPlanError || error instanceof DocumentAssetError) return failEdit(error.code)
  if (error && typeof error === 'object' && 'code' in error && ['ACCESS_DENIED', 'APP_UNAVAILABLE'].includes(String(error.code))) failEdit(error.code as EditCode)
  const message = error instanceof Error ? error.message : String(error)
  if (/ID reused/.test(message)) failEdit('OPERATION_ID_MISMATCH')
  if (/revision conflict/i.test(message)) failEdit('REVISION_CONFLICT')
  if (/editor (has unsaved|changed)|commit in progress/i.test(message)) failEdit('EDITOR_BUSY')
  if (/recovery|prepared operation|Conflicting document operation/i.test(message)) failEdit('RECOVERY_REQUIRED')
  if (/write admission|access denied|request expired|connection revoked/i.test(message)) failEdit('ACCESS_DENIED')
  if (/vault changed/i.test(message)) failEdit('ACCESS_DENIED')
  if (/storage is unavailable/.test(message)) failEdit('APP_UNAVAILABLE')
  if (/evidence limit/.test(message)) failEdit('LIMIT_EXCEEDED')
  if (/too large/.test(message)) failEdit('LIMIT_EXCEEDED')
  failEdit(fallback)
}
