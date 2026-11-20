// Every error code the server can answer with (ADR-0005), shared with the Go server through vectors/errors.json: a Go test
// checks that the server answers exactly these (status, code) pairs, a TypeScript test that the client knows them all.
import catalog from '../vectors/errors.json' with { type: 'json' }

export interface ErrorSpec { status: number; code: string; retryable: boolean; note: string }
export const ERRORS: readonly ErrorSpec[] = catalog
export const ERROR_CODES: ReadonlySet<string> = new Set(ERRORS.map(e => e.code))
/** Whether a client should retry a request that was answered with this code (a 5xx, 429, or no answer at all). */
export const isRetryableCode = (code: string): boolean => ERRORS.find(e => e.code === code)?.retryable ?? false
