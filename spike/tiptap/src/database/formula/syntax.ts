// Formula lexer + parser (handoff §15). Hand written, no eval / new Function. Precedence, high to low:
// member/call; exponent (right-associative); unary; multiplicative; additive; comparison/equality; and; or; ternary.
import type { Json } from '../model/types.ts'

export const LANGUAGE_VERSION = 1
export const MAX_AST_NODES = 10_000

export class FormulaSyntaxError extends Error {
  code: 'FORMULA_SYNTAX' | 'FORMULA_BUDGET'
  from: number
  to: number
  constructor(message: string, from: number, to: number, code: 'FORMULA_SYNTAX' | 'FORMULA_BUDGET' = 'FORMULA_SYNTAX') {
    super(message)
    this.code = code
    this.from = from
    this.to = to
  }
}

// every node carries its source span so diagnostics can point at the exact place
export type Node =
  | { t: 'num'; v: number; from: number; to: number }
  | { t: 'str'; v: string; from: number; to: number }
  | { t: 'bool'; v: boolean; from: number; to: number }
  | { t: 'list'; items: Node[]; from: number; to: number }
  | { t: 'ident'; name: string; from: number; to: number }
  /** prop("Name") (recv null) or recv.prop("Name"); `id` is bound at compile time and survives renames */
  | { t: 'prop'; name: string; id: string | null; recv: Node | null; nameFrom: number; nameTo: number; from: number; to: number }
  | { t: 'call'; fn: string; args: Node[]; method: boolean; from: number; to: number }
  | { t: 'un'; op: '-' | '!'; arg: Node; from: number; to: number }
  | { t: 'bin'; op: string; l: Node; r: Node; from: number; to: number }
  | { t: 'cond'; test: Node; a: Node; b: Node; from: number; to: number }

type Tok =
  | { k: 'num'; v: number; from: number; to: number }
  | { k: 'str'; v: string; from: number; to: number }
  | { k: 'id'; v: string; from: number; to: number }
  | { k: 'op'; v: string; from: number; to: number }
  | { k: 'eof'; from: number; to: number }

const isIdStart = (c: string) => /[\p{L}_$]/u.test(c)
const isIdPart = (c: string) => /[\p{L}\p{N}_$]/u.test(c)

const OPS3 = ['===', '!==']
const OPS2 = ['==', '!=', '<=', '>=', '&&', '||']
const OPS1 = '()[],.?:+-*/%^<>!'

export function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    const from = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!
      const v = Number(m[0])
      if (!Number.isFinite(v)) throw new FormulaSyntaxError('number is not finite', from, from + m[0].length)
      i += m[0].length
      out.push({ k: 'num', v, from, to: i })
      continue
    }
    if (c === '"' || c === "'") {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError('unterminated string', from, i)
        const d = src[i]
        if (d === c) { i++; break }
        if (d === '\\') {
          const e = src[i + 1]
          if (e === undefined) throw new FormulaSyntaxError('unterminated string', from, i)
          if (e === 'n') s += '\n'
          else if (e === 't') s += '\t'
          else if (e === 'r') s += '\r'
          else if (e === '"' || e === "'" || e === '\\') s += e
          else if (e === 'u') {
            const br = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2))
            const fx = /^[0-9a-fA-F]{4}/.exec(src.slice(i + 2))
            const hex = br ? br[1] : fx?.[0]
            if (!hex) throw new FormulaSyntaxError('bad \\u escape', i, i + 2)
            const cp = parseInt(hex, 16)
            if (cp > 0x10ffff) throw new FormulaSyntaxError('bad \\u escape', i, i + 2)
            s += String.fromCodePoint(cp)
            i += 2 + (br ? br[0].length : 4)
            continue
          } else throw new FormulaSyntaxError(`unknown escape \\${e}`, i, i + 2)
          i += 2
          continue
        }
        s += d
        i++
      }
      out.push({ k: 'str', v: s, from, to: i })
      continue
    }
    if (isIdStart(c)) {
      let j = i + 1
      while (j < src.length && isIdPart(src[j])) j++
      out.push({ k: 'id', v: src.slice(i, j), from, to: j })
      i = j
      continue
    }
    const three = src.slice(i, i + 3)
    if (OPS3.includes(three)) { out.push({ k: 'op', v: three === '===' ? '==' : '!=', from, to: i + 3 }); i += 3; continue }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) { out.push({ k: 'op', v: two, from, to: i + 2 }); i += 2; continue }
    if (OPS1.includes(c)) { out.push({ k: 'op', v: c, from, to: i + 1 }); i++; continue }
    throw new FormulaSyntaxError(`unexpected character ${JSON.stringify(c)}`, i, i + 1)
  }
  out.push({ k: 'eof', from: src.length, to: src.length })
  return out
}

export const RESERVED = new Set(['current', 'index', 'true', 'false', 'and', 'or', 'not'])

class Parser {
  toks: Tok[]
  p = 0
  nodes = 0
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  peek = () => this.toks[this.p]
  next = () => this.toks[this.p++]
  isOp = (v: string) => this.peek().k === 'op' && (this.peek() as { v: string }).v === v
  isWord = (v: string) => this.peek().k === 'id' && (this.peek() as { v: string }).v === v
  eatOp(v: string) {
    if (this.isOp(v)) return this.next()
    const t = this.peek()
    throw new FormulaSyntaxError(`expected "${v}"`, t.from, t.to)
  }
  mk<T extends Node>(n: T): T {
    if (++this.nodes > MAX_AST_NODES) throw new FormulaSyntaxError(`formula has more than ${MAX_AST_NODES} nodes`, n.from, n.to, 'FORMULA_BUDGET')
    return n
  }

  ternary(): Node {
    const test = this.or()
    if (this.isOp('?')) {
      this.next()
      const a = this.ternary()
      this.eatOp(':')
      const b = this.ternary()
      return this.mk({ t: 'cond', test, a, b, from: test.from, to: b.to })
    }
    return test
  }
  or(): Node {
    let l = this.and()
    while (this.isOp('||') || this.isWord('or')) {
      this.next()
      const r = this.and()
      l = this.mk({ t: 'bin', op: '||', l, r, from: l.from, to: r.to })
    }
    return l
  }
  and(): Node {
    let l = this.cmp()
    while (this.isOp('&&') || this.isWord('and')) {
      this.next()
      const r = this.cmp()
      l = this.mk({ t: 'bin', op: '&&', l, r, from: l.from, to: r.to })
    }
    return l
  }
  cmp(): Node {
    let l = this.add()
    while (['==', '!=', '<', '<=', '>', '>='].some((o) => this.isOp(o))) {
      const op = (this.next() as { v: string }).v
      const r = this.add()
      l = this.mk({ t: 'bin', op, l, r, from: l.from, to: r.to })
    }
    return l
  }
  add(): Node {
    let l = this.mul()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { v: string }).v
      const r = this.mul()
      l = this.mk({ t: 'bin', op, l, r, from: l.from, to: r.to })
    }
    return l
  }
  mul(): Node {
    let l = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { v: string }).v
      const r = this.unary()
      l = this.mk({ t: 'bin', op, l, r, from: l.from, to: r.to })
    }
    return l
  }
  unary(): Node {
    const t = this.peek()
    if (this.isOp('-') || this.isOp('!') || this.isWord('not') || this.isOp('+')) {
      this.next()
      const arg = this.unary()
      const op = (t as { v: string }).v
      if (op === '+') return arg
      return this.mk({ t: 'un', op: op === '-' ? '-' : '!', arg, from: t.from, to: arg.to })
    }
    return this.pow()
  }
  // exponent binds tighter than unary minus and is right associative: -2^2 = -(2^2), 2^3^2 = 2^(3^2)
  pow(): Node {
    const base = this.postfix()
    if (this.isOp('^')) {
      this.next()
      const exp = this.unaryForPow()
      return this.mk({ t: 'bin', op: '^', l: base, r: exp, from: base.from, to: exp.to })
    }
    return base
  }
  unaryForPow(): Node {
    // the exponent may carry its own sign: 2^-1
    if (this.isOp('-')) {
      const t = this.next()
      const arg = this.unaryForPow()
      return this.mk({ t: 'un', op: '-', arg, from: t.from, to: arg.to })
    }
    return this.pow()
  }
  postfix(): Node {
    let n = this.primary()
    while (this.isOp('.')) {
      this.next()
      const nameTok = this.next()
      if (nameTok.k !== 'id') throw new FormulaSyntaxError('expected a function name after "."', nameTok.from, nameTok.to)
      this.eatOp('(')
      const args = this.args()
      const close = this.eatOp(')')
      if (nameTok.v === 'prop') {
        const a = args[0]
        if (args.length !== 1 || a.t !== 'str') throw new FormulaSyntaxError('prop() needs one literal property name', nameTok.from, close.to)
        n = this.mk({ t: 'prop', name: a.v, id: null, recv: n, nameFrom: a.from, nameTo: a.to, from: n.from, to: close.to })
      } else n = this.mk({ t: 'call', fn: nameTok.v, args: [n, ...args], method: true, from: n.from, to: close.to })
    }
    return n
  }
  args(): Node[] {
    const out: Node[] = []
    if (this.isOp(')')) return out
    for (;;) {
      out.push(this.ternary())
      if (this.isOp(',')) { this.next(); continue }
      break
    }
    return out
  }
  primary(): Node {
    const t = this.next()
    switch (t.k) {
      case 'num': return this.mk({ t: 'num', v: t.v, from: t.from, to: t.to })
      case 'str': return this.mk({ t: 'str', v: t.v, from: t.from, to: t.to })
      case 'id': {
        if (t.v === 'true' || t.v === 'false') return this.mk({ t: 'bool', v: t.v === 'true', from: t.from, to: t.to })
        if (this.isOp('(')) {
          this.next()
          const args = this.args()
          const close = this.eatOp(')')
          if (t.v === 'prop') {
            const a = args[0]
            if (args.length !== 1 || a.t !== 'str') throw new FormulaSyntaxError('prop() needs one literal property name', t.from, close.to)
            return this.mk({ t: 'prop', name: a.v, id: null, recv: null, nameFrom: a.from, nameTo: a.to, from: t.from, to: close.to })
          }
          return this.mk({ t: 'call', fn: t.v, args, method: false, from: t.from, to: close.to })
        }
        return this.mk({ t: 'ident', name: t.v, from: t.from, to: t.to })
      }
      case 'op': {
        if (t.v === '(') {
          const inner = this.ternary()
          this.eatOp(')')
          return inner
        }
        if (t.v === '[') {
          const items: Node[] = []
          if (!this.isOp(']')) {
            for (;;) {
              items.push(this.ternary())
              if (this.isOp(',')) { this.next(); continue }
              break
            }
          }
          const close = this.eatOp(']')
          return this.mk({ t: 'list', items, from: t.from, to: close.to })
        }
        throw new FormulaSyntaxError(`unexpected "${t.v}"`, t.from, t.to)
      }
      case 'eof': throw new FormulaSyntaxError('unexpected end of formula', t.from, t.to)
    }
  }
}

export function parse(src: string): Node {
  const toks = lex(src)
  const p = new Parser(toks)
  if (p.peek().k === 'eof') throw new FormulaSyntaxError('empty formula', 0, 0)
  const n = p.ternary()
  const t = p.peek()
  if (t.k !== 'eof') throw new FormulaSyntaxError(`unexpected ${t.k === 'op' || t.k === 'id' ? `"${t.v}"` : t.k}`, t.from, t.to)
  return n
}

export const astToJson = (n: Node): Json => JSON.parse(JSON.stringify(n))
export const astFromJson = (j: Json): Node => j as unknown as Node

/** Visit every node (pre-order). */
export function walk(n: Node, f: (n: Node) => void): void {
  f(n)
  switch (n.t) {
    case 'list': n.items.forEach((c) => walk(c, f)); break
    case 'prop': if (n.recv) walk(n.recv, f); break
    case 'call': n.args.forEach((c) => walk(c, f)); break
    case 'un': walk(n.arg, f); break
    case 'bin': walk(n.l, f); walk(n.r, f); break
    case 'cond': walk(n.test, f); walk(n.a, f); walk(n.b, f); break
    default: break
  }
}
