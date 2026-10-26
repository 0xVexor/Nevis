// Formula compile step: parse, bind property names to ids (so renames never break a formula), infer / check static types,
// extract dependencies. Type problems that are certain become FORMULA_TYPE diagnostics; anything unknown defers to runtime.
import type { FormulaDiagnostic, Id, Json } from '../model/types.ts'
import { matchKey } from '../text.ts'
import { elemType, FUNCTIONS, isListType } from './functions.ts'
import { astToJson, FormulaSyntaxError, LANGUAGE_VERSION, parse, RESERVED, walk, type Node } from './syntax.ts'

export interface PropInfo {
  id: Id
  name: string
  /** static type: number | text | boolean | date | person | page | page@<sourceId> | list<…> | any */
  type: string
}

export interface Schema {
  props: PropInfo[]
  /** properties of another source (for page@<sourceId> typed references) */
  sourceProps?: (sourceId: Id) => PropInfo[]
}

export interface Dependencies {
  /** properties of the formula's own source that it reads */
  ownPropertyIds: Id[]
  /** properties of related sources read through page.prop("…") */
  relatedPropertyIds: Id[]
  /** at least one page.prop("…") could not be resolved statically: depends on the whole target source */
  dynamicRelated: boolean
  usesNow: boolean
  usesToday: boolean
}

export type Compiled =
  | { ok: true; ast: Node; source: string; resolvedRefs: Record<string, Id>; resultType: string; deps: Dependencies }
  | { ok: false; diagnostics: FormulaDiagnostic[] }

const LAMBDA_FNS = new Set(['map', 'filter', 'find', 'findIndex', 'some', 'every', 'sort'])
const OP_FN: Record<string, string> = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'mod', '^': 'pow', '==': 'equal', '!=': 'unequal', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', '&&': 'and', '||': 'or' }
export const operatorFunction = (op: string) => OP_FN[op]

const known = (t: string) => t !== 'any' && t !== ''
const baseOf = (t: string) => (t.startsWith('page@') ? 'page' : isListType(t) ? 'list' : t)

/** Does a static type satisfy an argument spec such as 'number|text'? Unknown types always pass. */
function fits(actual: string, want: string): boolean {
  if (!known(actual) || want === 'any') return true
  return want.split('|').some((w) => w === baseOf(actual) || (w === 'list' && isListType(actual)))
}

export const unify = (a: string, b: string) => (a === b ? a : a === 'any' ? b : b === 'any' ? a : baseOf(a) === baseOf(b) ? baseOf(a) : 'any')

/** `vars` are lexical names the caller seeds at evaluation time (workflow variables), with their static types. */
export function compileFormula(source: string, schema: Schema, vars: Record<string, string> = {}): Compiled {
  let ast: Node
  try {
    ast = parse(source)
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { ok: false, diagnostics: [{ code: e.code, message: e.message, from: e.from, to: e.to }] }
    throw e
  }
  const diags: FormulaDiagnostic[] = []
  const d = (code: string, message: string, n: { from: number; to: number }) => diags.push({ code, message, from: n.from, to: n.to })
  const byName = new Map<string, PropInfo[]>()
  for (const p of schema.props) (byName.get(matchKey(p.name).trim()) ?? byName.set(matchKey(p.name).trim(), []).get(matchKey(p.name).trim())!).push(p)
  const resolvedRefs: Record<string, Id> = {}

  function infer(n: Node, scope: Map<string, string>): string {
    switch (n.t) {
      case 'num': return 'number'
      case 'str': return 'text'
      case 'bool': return 'boolean'
      case 'list': {
        const ts = n.items.map((i) => infer(i, scope))
        return `list<${ts.length ? ts.reduce((a, b) => unify(a, b)) : 'any'}>`
      }
      case 'ident': {
        const t = scope.get(n.name)
        if (t === undefined) { d('FORMULA_NAME', `unknown name "${n.name}"`, n); return 'any' }
        return t
      }
      case 'prop': {
        let list: PropInfo[] | undefined
        if (n.recv === null) list = schema.props
        else {
          const rt = infer(n.recv, scope)
          if (known(rt) && baseOf(rt) !== 'page') d('FORMULA_TYPE', `.prop() needs a Page, got ${rt}`, n.recv)
          const src = rt.startsWith('page@') ? rt.slice(5) : null
          list = src && schema.sourceProps ? schema.sourceProps(src) : undefined
        }
        if (!list) return 'any' // resolved by name at runtime
        const hits = list.filter((p) => matchKey(p.name).trim() === matchKey(n.name).trim())
        if (hits.length === 0) { d('FORMULA_NAME', `unknown property "${n.name}"`, n); return 'any' }
        if (hits.length > 1) { d('FORMULA_NAME', `property name "${n.name}" is ambiguous`, n); return 'any' }
        n.id = hits[0].id
        if (n.recv === null) resolvedRefs[hits[0].name] = hits[0].id
        return hits[0].type
      }
      case 'un': {
        const t = infer(n.arg, scope)
        const want = n.op === '-' ? 'number' : 'boolean'
        if (!fits(t, want)) d('FORMULA_TYPE', `"${n.op}" needs a ${want}, got ${t}`, n)
        return want
      }
      case 'bin': {
        const a = infer(n.l, scope)
        const b = infer(n.r, scope)
        const fn = OP_FN[n.op]
        if (n.op === '+') {
          if (known(a) && known(b)) {
            const ok = (baseOf(a) === 'number' && baseOf(b) === 'number') || (baseOf(a) === 'text' && baseOf(b) === 'text')
            if (!ok) d('FORMULA_TYPE', `cannot add ${a} and ${b}`, n)
            return baseOf(a) === 'text' ? 'text' : 'number'
          }
          return known(a) ? baseOf(a) : known(b) ? baseOf(b) : 'any'
        }
        if (['-', '*', '/', '%', '^'].includes(n.op)) {
          for (const [t, x] of [[a, n.l], [b, n.r]] as [string, Node][]) if (!fits(t, 'number')) d('FORMULA_TYPE', `"${n.op}" needs Numbers, got ${t}`, x)
          return 'number'
        }
        if (n.op === '&&' || n.op === '||') {
          for (const [t, x] of [[a, n.l], [b, n.r]] as [string, Node][]) if (!fits(t, 'boolean')) d('FORMULA_TYPE', `"${n.op}" needs Booleans, got ${t}`, x)
          return 'boolean'
        }
        if (['<', '<=', '>', '>='].includes(n.op) && known(a) && known(b) && baseOf(a) !== baseOf(b)) d('FORMULA_TYPE', `cannot compare ${a} with ${b}`, n)
        void fn
        return 'boolean'
      }
      case 'cond': {
        const t = infer(n.test, scope)
        if (!fits(t, 'boolean')) d('FORMULA_TYPE', `the condition must be a Boolean, got ${t}`, n.test)
        return unify(infer(n.a, scope), infer(n.b, scope))
      }
      case 'call': {
        const spec = FUNCTIONS[n.fn]
        if (!spec || spec.hidden) { d('FORMULA_NAME', `unknown function "${n.fn}"`, n); n.args.forEach((x) => infer(x, scope)); return 'any' }
        if (n.args.length < spec.min || n.args.length > spec.max) {
          d('FORMULA_ARITY', `${n.fn} takes ${spec.min === spec.max ? spec.min : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min}-${spec.max}`} argument(s), got ${n.args.length}`, n)
        }
        // bindings: let / lets add lexical names, lambdas add current / index
        const types: string[] = []
        if (n.fn === 'let' || n.fn === 'lets') {
          let sc = scope
          const out: string[] = []
          for (let i = 0; i + 1 < n.args.length; i += 2) {
            const nm = n.args[i]
            if (nm.t !== 'ident') { d('FORMULA_SYNTAX', 'binding name expected', nm); continue }
            if (RESERVED.has(nm.name) || FUNCTIONS[nm.name]) d('FORMULA_NAME', `"${nm.name}" is reserved`, nm)
            const vt = infer(n.args[i + 1], sc)
            sc = new Map(sc)
            sc.set(nm.name, vt)
            out.push(vt)
          }
          return n.args.length ? infer(n.args[n.args.length - 1], sc) : 'any'
        }
        n.args.forEach((x, i) => {
          if (LAMBDA_FNS.has(n.fn) && i === 1) {
            const sc = new Map(scope)
            sc.set('current', elemType(types[0] ?? 'any'))
            sc.set('index', 'number')
            types.push(infer(x, sc))
          } else types.push(infer(x, scope))
        })
        if (spec.args) {
          types.forEach((t, i) => {
            if (LAMBDA_FNS.has(n.fn) && i === 1) return
            const want = spec.args![Math.min(i, spec.args!.length - 1)]
            if (n.fn === 'if' || n.fn === 'ifs') return
            if (!fits(t, want)) d('FORMULA_TYPE', `${n.fn}: argument ${i + 1} must be ${want}, got ${t}`, n.args[i])
          })
        }
        if (n.fn === 'if' && types.length && !fits(types[0], 'boolean')) d('FORMULA_TYPE', 'if: the condition must be a Boolean', n.args[0])
        if (n.fn === 'map') return `list<${types[1] ?? 'any'}>`
        return spec.returns(types)
      }
    }
  }

  const resultType = infer(ast, new Map(Object.entries(vars)))
  if (diags.length) return { ok: false, diagnostics: diags }

  const own = new Set<Id>()
  const related = new Set<Id>()
  let dynamicRelated = false
  let usesNow = false
  let usesToday = false
  walk(ast, (n) => {
    if (n.t === 'prop') {
      if (n.recv === null && n.id) own.add(n.id)
      else if (n.id) related.add(n.id)
      else dynamicRelated = true
    }
    if (n.t === 'call' && n.fn === 'now') usesNow = true
    if (n.t === 'call' && n.fn === 'today') usesToday = true
  })
  return {
    ok: true, ast, source, resolvedRefs, resultType,
    deps: { ownPropertyIds: [...own], relatedPropertyIds: [...related], dynamicRelated, usesNow, usesToday },
  }
}

/** The JSON stored as a Formula property's config. */
export function formulaConfigOf(c: Extract<Compiled, { ok: true }>): Json {
  return { languageVersion: LANGUAGE_VERSION, source: c.source, ast: astToJson(c.ast), resolvedRefs: c.resolvedRefs, resultType: c.resultType }
}

/**
 * A property was renamed: rewrite the literal name in the stored source (spans come from the AST) and in the AST itself.
 * Bindings use ids, so evaluation was never at risk; this only keeps the visible source in step.
 */
export function renameInFormula(source: string, ast: Node, propertyId: Id, newName: string): { source: string; ast: Node } {
  const spans: { from: number; to: number }[] = []
  walk(ast, (n) => {
    if (n.t === 'prop' && n.id === propertyId) {
      spans.push({ from: n.nameFrom, to: n.nameTo })
      n.name = newName
    }
  })
  let out = source
  for (const s of spans.sort((a, b) => b.from - a.from)) out = out.slice(0, s.from) + JSON.stringify(newName) + out.slice(s.to)
  // spans of later nodes moved: re-parse the rewritten text and re-attach ids so offsets stay truthful
  const reparsed = parse(out)
  const ids: Id[] = []
  walk(ast, (n) => { if (n.t === 'prop') ids.push(n.id as Id) })
  let k = 0
  walk(reparsed, (n) => { if (n.t === 'prop') n.id = ids[k++] ?? null })
  return { source: out, ast: reparsed }
}
