// Formula interpreter: tree-walking, bounded by a step budget, list/text limits and a wall-clock watchdog. Pure: the clock,
// property access and people lookup are injected through FormulaEnv.
import type { FormulaDiagnostic, FormulaResult, FormulaValue } from '../model/types.ts'
import { plain, numV, boolV, textV, EMPTY_V, listV } from './values.ts'
import { FUNCTIONS, type Arg } from './functions.ts'
import { operatorFunction } from './compile.ts'
import { BUDGET, Blocked, FormulaError, lookup, newScope, type Budget, type Ctx, type FormulaEnv, type Scope } from './runtime.ts'
import type { Node } from './syntax.ts'

export type EvalOptions = { signal?: { aborted: boolean }; vars?: Record<string, FormulaValue> }

function isLazyAt(spec: { lazy?: { at?: number[]; from?: number } }, i: number): boolean {
  const l = spec.lazy
  if (!l) return false
  return (l.at?.includes(i) ?? false) || (l.from !== undefined && i >= l.from)
}

export function evaluate(ast: Node, env: FormulaEnv, opts: EvalOptions = {}): FormulaResult {
  const budget: Budget = { ...BUDGET, ...env.budget }
  let steps = 0
  const started = env.clock ? env.clock() : 0

  const fail = (node: Node, code: string, message: string): never => {
    throw new FormulaError(code, message, node.from, node.to)
  }
  const tick = (node: Node, n = 1) => {
    steps += n
    if (steps > budget.maxSteps) fail(node, 'FORMULA_BUDGET', `formula exceeded ${budget.maxSteps} evaluation steps`)
    if ((steps & 255) === 0) {
      if (opts.signal?.aborted) fail(node, 'FORMULA_BUDGET', 'evaluation cancelled')
      if (env.clock && env.clock() - started > budget.watchdogMs) fail(node, 'FORMULA_BUDGET', `formula exceeded ${budget.watchdogMs} ms`)
    }
  }

  const cxFor = (scope: Scope): Ctx => ({ env, budget, scope, eval: ev, tick, err: fail, fail })

  function callSpec(name: string, argNodes: Node[], node: Node, scope: Scope): FormulaValue {
    const spec = FUNCTIONS[name]
    if (!spec) return fail(node, 'FORMULA_NAME', `unknown function "${name}"`)
    if (argNodes.length < spec.min || argNodes.length > spec.max) return fail(node, 'FORMULA_ARITY', `${name} takes ${spec.min}-${spec.max === Infinity ? '…' : spec.max} arguments, got ${argNodes.length}`)
    const cx = cxFor(scope)
    const args: Arg[] = []
    let sawEmpty = false
    for (let i = 0; i < argNodes.length; i++) {
      if (isLazyAt(spec, i)) args.push(argNodes[i])
      else {
        const v = ev(argNodes[i], scope)
        if (v.kind === 'empty') sawEmpty = true
        args.push(v)
      }
    }
    if (sawEmpty && spec.propagateEmpty) return EMPTY_V
    const out = spec.impl(args, cx, node)
    if (out.kind === 'text' && plain(out).length * 2 > budget.maxTextBytes) fail(node, 'FORMULA_BUDGET', 'text is larger than 1 MB')
    if (out.kind === 'list' && out.items.length > budget.maxListItems) fail(node, 'FORMULA_BUDGET', `list is longer than ${budget.maxListItems} items`)
    return out
  }

  function ev(node: Node, scope: Scope): FormulaValue {
    tick(node)
    switch (node.t) {
      case 'num': return numV(node.v)
      case 'str': return textV(node.v)
      case 'bool': return boolV(node.v)
      case 'list': {
        const items = node.items.map((i) => ev(i, scope))
        if (items.length > budget.maxListItems) fail(node, 'FORMULA_BUDGET', 'list is too long')
        return listV(items)
      }
      case 'ident': {
        const v = lookup(scope, node.name)
        if (v === undefined) return fail(node, 'FORMULA_NAME', `unknown name "${node.name}"`)
        return v
      }
      case 'prop': {
        let pageId = env.currentPageId
        if (node.recv) {
          const r = ev(node.recv, scope)
          if (r.kind === 'empty') return EMPTY_V
          if (r.kind !== 'page') return fail(node, 'FORMULA_TYPE', '.prop() needs a Page')
          pageId = r.id
        }
        const pid = node.id ?? env.findProp(pageId, node.name)
        if (!pid) return fail(node, 'FORMULA_NAME', `unknown property "${node.name}"`)
        try {
          return env.getProp(pageId, pid)
        } catch (err) {
          // a referenced formula already failed: report it at this reference
          if (err instanceof FormulaError && (err as FormulaError & { propagated?: boolean }).propagated) throw new FormulaError(err.code, err.message, node.from, node.to)
          throw err
        }
      }
      case 'un': return callSpec(node.op === '-' ? 'subtract' : 'not', node.op === '-' ? [{ t: 'num', v: 0, from: node.from, to: node.from }, node.arg] : [node.arg], node, scope)
      case 'bin': return callSpec(operatorFunction(node.op), [node.l, node.r], node, scope)
      case 'cond': return callSpec('if', [node.test, node.a, node.b], node, scope)
      case 'call': return callSpec(node.fn, node.args, node, scope)
    }
  }

  try {
    const root = newScope()
    for (const [k, val] of Object.entries(opts.vars ?? {})) root.vars.set(k, val)
    const v = ev(ast, root)
    return { state: 'ready', value: v }
  } catch (e) {
    if (e instanceof Blocked) return { state: e.state }
    if (e instanceof FormulaError) {
      const d: FormulaDiagnostic = { code: e.code, message: e.message, from: e.from, to: e.to }
      return { state: 'error', diagnostics: [d] }
    }
    if (e instanceof RangeError) return { state: 'error', diagnostics: [{ code: 'FORMULA_BUDGET', message: 'formula is nested too deeply', from: ast.from, to: ast.to }] }
    throw e
  }
}
