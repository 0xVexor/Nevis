// Formula runtime: environment contract, evaluation budget, errors, scopes. The interpreter itself is in eval.ts.
import type { FormulaValue, Id } from '../model/types.ts'
import type { Node } from './syntax.ts'

export const BUDGET = {
  maxNodes: 10_000,
  maxSteps: 100_000,
  maxListItems: 10_000,
  maxTextBytes: 1024 * 1024,
  /** wall-clock watchdog per row in a Worker (trusted batch export may raise it) */
  watchdogMs: 200,
  maxRefDepth: 15,
}
export type Budget = typeof BUDGET

/** Thrown by the interpreter; carries the exact source span. */
export class FormulaError extends Error {
  code: string
  from: number
  to: number
  constructor(code: string, message: string, from: number, to: number) {
    super(message)
    this.code = code
    this.from = from
    this.to = to
  }
}

/** A referenced input is not available (yet) or not allowed: the whole result becomes pending / restricted, never empty or zero. */
export class Blocked extends Error {
  state: 'pending' | 'restricted'
  constructor(state: 'pending' | 'restricted') {
    super(state)
    this.state = state
  }
}

export interface PersonInfo {
  name: string
  email: string | null
}

/** What the evaluator may look at. The engine never touches storage, the network or the real clock. */
export interface FormulaEnv {
  vaultId: Id
  /** injected clock: the pure evaluator never calls Date.now() */
  nowMs: number
  zone: string
  currentPageId: Id
  /** value of a property of a page; throws Blocked for restricted/pending input or FormulaError-compatible failures */
  getProp(pageId: Id, propertyId: Id): FormulaValue
  /** runtime name resolution on the *source of that page* (used when no static type information exists) */
  findProp(pageId: Id, name: string): Id | undefined
  pageTitle(pageId: Id): string | undefined
  person(id: Id): PersonInfo | undefined
  budget?: Partial<Budget>
  /** monotonic ms clock for the watchdog; optional */
  clock?: () => number
}

export interface Scope {
  parent: Scope | null
  vars: Map<string, FormulaValue>
}

export const newScope = (parent: Scope | null = null): Scope => ({ parent, vars: new Map() })

export function lookup(scope: Scope | null, name: string): FormulaValue | undefined {
  for (let s = scope; s; s = s.parent) {
    const v = s.vars.get(name)
    if (v !== undefined) return v
  }
  return undefined
}

export interface Ctx {
  env: FormulaEnv
  budget: Budget
  eval(node: Node, scope: Scope): FormulaValue
  scope: Scope
  tick(node: Node, n?: number): void
  err(node: Node, code: string, message: string): never
  fail(node: Node, code: string, message: string): never
}
