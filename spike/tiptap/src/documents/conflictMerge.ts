/**
 * Pure three-way comparison of the two versions of a page that was edited on two devices.
 * Top-level blocks are matched by block id (with an occurrence number when an id repeats, like the backend's
 * occ_keys); blocks without an id by a hash of their content. Every block of the result is an original block
 * object of one of the two versions, so nothing is re-serialised and nothing inside a block is merged except by
 * choosing a whole block.
 */
import type { DocNode } from '../docNode.ts'
import type { ConflictMarker, ConflictSideName } from '../conflict/types.ts'
import { isBlockId } from './blockIdentity.ts'

export type Choice = 'local' | 'remote' | 'both'
export type RowKind = 'unchanged' | 'local-only' | 'remote-only' | 'both' | 'added' | 'deleted' | 'delete-vs-edit'
export interface Token {
  /** del: only in this device's version, ins: only in the other device's, eq: in both. */
  op: 'eq' | 'del' | 'ins'
  text: string
}

export interface Row {
  /** 'title' for the title row, otherwise 'b0', 'b1'... in page order. */
  id: string
  kind: RowKind
  /** Blocks of each version this row stands for (empty: the block is absent there). A title row has none. */
  local: DocNode[]
  remote: DocNode[]
  /** Which device added or deleted the block (kinds 'added' and 'deleted'). */
  by?: ConflictSideName
  /** The same block sits at another position in the other version; the result keeps the position of this device's. */
  moved?: boolean
  /** Word diff of a paragraph/heading ('text') or line diff of a code block ('code'). */
  tokens?: Token[]
  tokenKind?: 'text' | 'code'
  /** The text is identical, only formatting or attributes differ. */
  formatOnly?: boolean
  /** Choices that make sense; empty for an unchanged row. */
  options: Choice[]
  /** What the comparison with the base suggests; null when the person has to decide. */
  preselected: Choice | null
  /** preselected, or the marker's kept side. */
  default: Choice
  needsChoice: boolean
  title?: { local: string; remote: string }
  /** Content that is not a TipTap doc (legacy HTML): one all-or-nothing row. */
  whole?: { local: unknown; remote: unknown }
}

export interface ConflictDiff {
  title: Row
  rows: Row[]
  hasBase: boolean
}

export interface Merged {
  content: unknown
  title: string
  /** The kept side's page (icon, tags, status, ...) with the merged title and content. */
  page: ConflictMarker['local']['page']
  /** Set when every choice came from one side, so the result is exactly that side's version. */
  side: ConflictSideName | null
}

// ---- keys and equality -------------------------------------------------------------------------------------------

/** JSON with sorted keys, so equal blocks compare equal whatever the order their attributes were written in. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const o = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
      .join(',') +
    '}'
  )
}

/** cyrb53: a small, well-spread string hash; a collision only costs an extra choice (equality compares the full text). */
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

interface Keyed {
  key: string
  node: DocNode
  canon: string
  hasId: boolean
}

function keyBlocks(blocks: DocNode[]): Keyed[] {
  const seen = new Map<string, number>()
  return blocks.map((node) => {
    const canon = canonical(node)
    const id = node.attrs?.blockId
    const hasId = isBlockId(id)
    const stem = hasId ? 'id:' + id : 'h:' + hash(canon)
    const n = seen.get(stem) ?? 0
    seen.set(stem, n + 1)
    return { key: `${stem}#${n}`, node, canon, hasId }
  })
}

/** Positions (in `seq`) of one longest strictly increasing subsequence, O(n log n). */
function lis(seq: number[]): Set<number> {
  const tails: number[] = []
  const prev: number[] = new Array(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i)
  return out
}

// ---- inline diff -------------------------------------------------------------------------------------------------

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

/** Words, spaces and punctuation as separate pieces, so joining them gives the text back. */
export const wordPieces = (text: string): string[] => (segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : text.split(/(\s+)/).filter(Boolean))
const linePieces = (text: string): string[] => text.split(/(?<=\n)/).filter(Boolean)

const LCS_LIMIT = 4_000_000

/** Diff of two piece lists (LCS after trimming what both share); equal neighbours are merged into one token. */
export function diffPieces(a: string[], b: string[]): Token[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--)
  const out: Token[] = []
  const push = (op: Token['op'], text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.op === op) last.text += text
    else out.push({ op, text })
  }
  push('eq', a.slice(0, start).join(''))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  if (x.length * y.length > LCS_LIMIT) {
    push('del', x.join(''))
    push('ins', y.join(''))
  } else {
    // table[i][j] = LCS length of x[i..] and y[j..]
    const w = y.length + 1
    const table = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) (push('eq', x[i]), i++, j++)
      else if (i < x.length && (j === y.length || table[(i + 1) * w + j] >= table[i * w + j + 1])) push('del', x[i++])
      else push('ins', y[j++])
    }
  }
  push('eq', a.slice(endA).join(''))
  return out
}

/** Plain text of a block's inline content; an inline object without text (a formula, a page link) shows as [type]. */
function plainText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.content) return node.content.map(plainText).join('')
  return `[${node.type}]`
}

function inlineDiff(l: DocNode, r: DocNode): Pick<Row, 'tokens' | 'tokenKind' | 'formatOnly'> {
  const text = (n: DocNode) => (n.content ?? []).map(plainText).join('')
  const kind = l.type === r.type && l.type === 'codeBlock' ? 'code' : l.type !== 'codeBlock' && r.type !== 'codeBlock' && (l.type === 'paragraph' || l.type === 'heading') && (r.type === 'paragraph' || r.type === 'heading') ? 'text' : null
  if (!kind) return {}
  const a = text(l)
  const b = text(r)
  const pieces = kind === 'code' ? linePieces : wordPieces
  return { tokens: diffPieces(pieces(a), pieces(b)), tokenKind: kind, formatOnly: a === b }
}

// ---- rows --------------------------------------------------------------------------------------------------------

interface Ctx {
  hasBase: boolean
  base: Map<string, Keyed>
  kept: ConflictSideName
}

type Draft = Omit<Row, 'id' | 'default' | 'needsChoice' | 'options'> & { options?: Choice[] }

const finish = (ctx: Ctx, id: string, d: Draft): Row => {
  const options = d.options ?? (d.kind === 'unchanged' ? [] : ['local', 'remote'])
  return { ...d, id, options, default: d.preselected ?? (options.length ? ctx.kept : 'local'), needsChoice: options.length > 0 && d.preselected === null }
}

const other = (side: ConflictSideName): ConflictSideName => (side === 'local' ? 'remote' : 'local')

function alignedRow(ctx: Ctx, l: Keyed, r: Keyed, moved: boolean): Draft {
  if (l.canon === r.canon) return { kind: 'unchanged', local: [l.node], remote: [r.node], preselected: null, ...(moved && { moved }) }
  const bl = ctx.base.get(l.key)
  const br = ctx.base.get(r.key)
  const localSame = !!bl && bl.canon === l.canon
  const remoteSame = !!br && br.canon === r.canon
  let kind: RowKind = 'both'
  let preselected: Choice | null = null
  if (ctx.hasBase && localSame && !remoteSame) (kind = 'remote-only', (preselected = 'remote'))
  else if (ctx.hasBase && remoteSame && !localSame) (kind = 'local-only', (preselected = 'local'))
  return { kind, local: [l.node], remote: [r.node], preselected, ...inlineDiff(l.node, r.node), ...(moved && { moved }) }
}

function singleRow(ctx: Ctx, side: ConflictSideName, k: Keyed): Draft {
  const nodes = { local: side === 'local' ? [k.node] : [], remote: side === 'remote' ? [k.node] : [] }
  const b = ctx.base.get(k.key)
  if (b) {
    // the other device deleted a block of the base: harmless when this one left it alone, a real conflict when it edited it
    if (b.canon === k.canon) return { kind: 'deleted', ...nodes, by: other(side), preselected: other(side) }
    return { kind: 'delete-vs-edit', ...nodes, by: other(side), preselected: null }
  }
  return { kind: 'added', ...nodes, by: side, preselected: ctx.hasBase ? side : null }
}

type Slot = { draft: Draft; add?: { side: ConflictSideName; node: DocNode } }

const docBlocks = (content: unknown): DocNode[] | null => {
  const doc = content as DocNode | null | undefined
  return doc && typeof doc === 'object' && doc.type === 'doc' ? (doc.content ?? []) : null
}

function titleDraft(ctx: Ctx, local: string, remote: string, base: string | undefined): Draft {
  const title = { local, remote }
  if (local === remote) return { kind: 'unchanged', local: [], remote: [], preselected: null, title }
  const tokens = diffPieces(wordPieces(local), wordPieces(remote))
  let kind: RowKind = 'both'
  let preselected: Choice | null = null
  if (ctx.hasBase && base !== undefined && local === base) (kind = 'remote-only', (preselected = 'remote'))
  else if (ctx.hasBase && base !== undefined && remote === base) (kind = 'local-only', (preselected = 'local'))
  return { kind, local: [], remote: [], preselected, title, tokens, tokenKind: 'text' }
}

/** The blocks between two shared blocks: pair what can be paired, then list each remaining block of either side. */
function gapDrafts(ctx: Ctx, local: Keyed[], remote: Keyed[], localKeys: Map<string, Keyed>, remoteKeys: Map<string, Keyed>): Draft[] {
  const localOnly = local.filter((k) => !remoteKeys.has(k.key))
  // a shared block inside a gap is one that moved: it takes this device's position and its copy in the other version is skipped
  const remoteOnly = remote.filter((k) => !localKeys.has(k.key))
  // legacy blocks (no id) changed on both sides are paired by position and type, instead of showing as two unrelated additions
  const pairOf = new Map<Keyed, Keyed>()
  const paired = new Set<Keyed>()
  for (let i = 0; i < Math.min(localOnly.length, remoteOnly.length); i++) {
    const l = localOnly[i]
    const r = remoteOnly[i]
    if (!l.hasId && !r.hasId && l.node.type === r.node.type) (pairOf.set(l, r), paired.add(r))
  }
  const slots: Slot[] = []
  const single = (side: ConflictSideName, k: Keyed) => {
    const draft = singleRow(ctx, side, k)
    slots.push(draft.kind === 'added' ? { draft, add: { side, node: k.node } } : { draft })
  }
  for (const l of local) {
    const same = remoteKeys.get(l.key)
    if (same) slots.push({ draft: alignedRow(ctx, l, same, true) })
    else if (pairOf.has(l)) slots.push({ draft: alignedRow(ctx, l, pairOf.get(l)!, false) })
    else single('local', l)
  }
  for (const r of remoteOnly) if (!paired.has(r)) single('remote', r)
  // additions on both sides at one position become one row that can keep both
  const adds = slots.filter((s) => s.add)
  const sides = (side: ConflictSideName) => adds.filter((s) => s.add!.side === side).map((s) => s.add!.node)
  if (sides('local').length && sides('remote').length) {
    adds[0].draft = { kind: 'added', local: sides('local'), remote: sides('remote'), options: ['local', 'remote', 'both'], preselected: ctx.hasBase ? 'both' : null }
    return slots.filter((s) => s === adds[0] || !s.add).map((s) => s.draft)
  }
  return slots.map((s) => s.draft)
}

export function diffConflict(marker: ConflictMarker): ConflictDiff {
  const lc = marker.local.page.content
  const rc = marker.remote.page.content
  const lb = docBlocks(lc)
  const rb = docBlocks(rc)
  const bb = docBlocks(marker.base?.content)
  const hasBase = !!marker.base && !!bb
  const ctx: Ctx = { hasBase, base: new Map(keyBlocks(bb ?? []).map((k) => [k.key, k])), kept: marker.kept }
  const title = finish(ctx, 'title', titleDraft(ctx, marker.local.page.title ?? '', marker.remote.page.title ?? '', marker.base?.title))

  if (!lb || !rb) {
    const rows = canonical(lc) === canonical(rc) ? [] : [finish(ctx, 'b0', { kind: 'both', local: [], remote: [], preselected: null, whole: { local: lc, remote: rc } })]
    return { title, hasBase, rows }
  }

  const local = keyBlocks(lb)
  const remote = keyBlocks(rb)
  const localKeys = new Map(local.map((k) => [k.key, k]))
  const remoteKeys = new Map(remote.map((k) => [k.key, k]))
  const remoteAt = new Map(remote.map((k, i) => [k.key, i]))
  // blocks both versions have, in this device's order; the longest run that is also in order on the other side stays put
  const commonAt: number[] = []
  local.forEach((k, i) => remoteAt.has(k.key) && commonAt.push(i))
  const inOrder = lis(commonAt.map((i) => remoteAt.get(local[i].key)!))

  const drafts: Draft[] = []
  let li = 0
  let ri = 0
  const gap = (lEnd: number, rEnd: number) => drafts.push(...gapDrafts(ctx, local.slice(li, lEnd), remote.slice(ri, rEnd), localKeys, remoteKeys))
  commonAt.forEach((a, n) => {
    if (!inOrder.has(n)) return
    const ra = remoteAt.get(local[a].key)!
    gap(a, ra)
    drafts.push(alignedRow(ctx, local[a], remote[ra], false))
    li = a + 1
    ri = ra + 1
  })
  gap(local.length, remote.length)
  return { title, hasBase, rows: drafts.map((d, i) => finish(ctx, 'b' + i, d)) }
}

// ---- applying the choices ----------------------------------------------------------------------------------------

/** The choice for a row: the person's if it is one of the row's options, otherwise the suggestion. */
export const choiceFor = (row: Row, choices: Record<string, Choice | undefined>): Choice => {
  const c = choices[row.id]
  return c && row.options.includes(c) ? c : row.default
}

export function defaultChoices(diff: ConflictDiff): Record<string, Choice> {
  return Object.fromEntries([diff.title, ...diff.rows].map((r) => [r.id, r.default]))
}

/**
 * Builds the page from the choices (a row without a choice takes its default). When every decision picked the same
 * side the result is that side's content and title exactly, including a different block order.
 */
export function applyChoices(marker: ConflictMarker, choices: Record<string, Choice | undefined>, diff: ConflictDiff = diffConflict(marker)): Merged {
  const decided = [diff.title, ...diff.rows].filter((r) => r.options.length).map((r) => choiceFor(r, choices))
  const sides = new Set(decided)
  const one: ConflictSideName | null = sides.size === 0 ? marker.kept : sides.size === 1 && !sides.has('both') ? ([...sides][0] as ConflictSideName) : null
  const from = (side: ConflictSideName, page = marker[side].page) => ({ content: page.content, title: page.title ?? '', page: { ...marker[marker.kept].page, title: page.title ?? '', content: page.content }, side })
  if (one) return from(one)

  const whole = diff.rows.find((r) => r.whole)
  const title = (() => {
    const t = diff.title.title!
    return t[(choiceFor(diff.title, choices) === 'remote' ? 'remote' : 'local') as ConflictSideName]
  })()
  const keptPage = marker[marker.kept].page
  if (whole) {
    const content = whole.whole![choiceFor(whole, choices) === 'remote' ? 'remote' : 'local']
    return { content, title, page: { ...keptPage, title, content }, side: null }
  }
  const blocks: DocNode[] = []
  for (const row of diff.rows) {
    const c = choiceFor(row, choices)
    if (c !== 'remote') blocks.push(...row.local)
    if (c !== 'local') blocks.push(...row.remote)
  }
  // a page needs at least one block
  const content = { ...(keptPage.content as object), type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }
  return { content, title, page: { ...keptPage, title, content }, side: null }
}
