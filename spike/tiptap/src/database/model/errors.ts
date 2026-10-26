// Stable machine-readable error codes (handoff §12). UI messages are localized from the code; the code never changes.

export type ErrorCode =
  | 'NOT_FOUND' | 'ACCESS_DENIED' | 'SCHEMA_MISMATCH' | 'INVALID_VALUE' | 'INVALID_FILTER' | 'UNSUPPORTED_CONVERSION'
  | 'RELATION_LIMIT' | 'CYCLE' | 'FORMULA_TYPE' | 'FORMULA_DEPTH' | 'FORMULA_BUDGET' | 'STALE_CURSOR' | 'REVISION_CONFLICT'
  | 'READ_ONLY' | 'QUOTA' | 'IO' | 'PROVIDER_UNAVAILABLE' | 'MISSING_CREDENTIALS' | 'RECOVERY_REQUIRED'
  // finer codes used inside the formula engine / commands; they all map onto a family above
  | 'FORMULA_DOMAIN' | 'FORMULA_SYNTAX' | 'FORMULA_NAME' | 'FORMULA_ARITY' | 'FORMULA_REGEX' | 'INVALID_COMMAND' | 'UNSUPPORTED'

export class DbError extends Error {
  code: ErrorCode
  detail: Record<string, unknown>
  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.detail = detail
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

export function fail(code: ErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new DbError(code, message, detail)
}

export const isDbError = (e: unknown): e is DbError => e instanceof DbError

/** Messages never carry credentials or whole private records; unknown errors are reduced to a string. */
export function toDbError(e: unknown): DbError {
  if (isDbError(e)) return e
  return new DbError('IO', e instanceof Error ? e.message : String(e))
}
