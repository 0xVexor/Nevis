import { BLOCK_TYPES, BLOCK_IDENTITY_VERSION, identityVersion, isBlockId } from './blockIdentity.ts'
import type { IdentityNode } from './blockIdentity.ts'
import { LIMITS } from './contracts.ts'
import type { Page } from './model.ts'
import { normalizeFa } from './normalize.ts'

export const LEXICAL_PROJECTION_VERSION = 1
export type SearchMode = 'keywords' | 'phrase' | 'literal'
type Token = { term: string; from: number; to: number }
type Unit = { documentId: string; blockId: string | null; source: 'title' | 'tag' | 'body'; order: number; text: string; tokens: Token[] }
export type LexicalMatch = Unit & { score: number; from: number; to: number }
export class LexicalSearchError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'LIMIT_EXCEEDED'
  constructor(code: 'INVALID_ARGUMENT' | 'LIMIT_EXCEEDED') { super(code); this.code = code }
}
const blockTypes = new Set<string>(BLOCK_TYPES)

/** Offsets point into the original UTF-16 source word, including its harakat.
 * ZWNJ and directional controls are separators, as in normalizeFa. Normalize
 * complete words so Unicode case conversion does not change source offsets. */
function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)].flatMap(match => {
    const term = normalizeFa(match[0])
    return term ? [{ term, from: match.index, to: match.index + match[0].length }] : []
  })
}
const inlineText = (node: IdentityNode, unsupported: () => void): string => {
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mathInline') return typeof node.attrs?.latex === 'string' ? node.attrs.latex : ''
  if (node.type === 'pageLink') return typeof node.attrs?.label === 'string' ? node.attrs.label : ''
  if (node.type === 'inlineIcon') return ''
  if (!['paragraph', 'heading', 'codeBlock'].includes(node.type)) unsupported()
  return (node.content ?? []).map(child => inlineText(child, unsupported)).join('')
}

/** One portable positional engine. No DOM, FTS, storage or hidden-note lookup.
 * Callers supply an already-authorized persisted snapshot on every rebuild. */
export class PortableLexicalIndex {
  private readonly units: Unit[] = []
  private readonly postings = new Map<string, Map<number, number[]>>()
  private readonly documentTerms = new Map<string, Set<string>>()
  readonly unsupportedDocumentIds = new Set<string>()
  constructor(pages: readonly Page[]) {
    for (const page of pages) {
      if (page.deletedAt !== null || page.kind === 'folder') continue
      let order = 0
      const add = (text: string, source: Unit['source'], blockId: string | null) => {
        if (!text) return
        const unit: Unit = { documentId: page.id, source, blockId, order: order++, text, tokens: tokenize(text) }
        const unitId = this.units.push(unit) - 1
        const terms = this.documentTerms.get(page.id) ?? new Set<string>()
        unit.tokens.forEach((token, position) => {
          terms.add(token.term)
          const byUnit = this.postings.get(token.term) ?? new Map<number, number[]>()
          const positions = byUnit.get(unitId) ?? []
          positions.push(position); byUnit.set(unitId, positions); this.postings.set(token.term, byUnit)
        })
        this.documentTerms.set(page.id, terms)
      }
      add(page.title, 'title', null)
      for (const tag of page.tags ?? []) add(tag, 'tag', null)
      if (identityVersion(page.content) !== BLOCK_IDENTITY_VERSION || page.content?.type !== 'doc') {
        this.unsupportedDocumentIds.add(page.id); continue
      }
      const seen = new Set<string>()
      let valid = true
      const check = (node: IdentityNode, depth: number) => {
        if (depth > LIMITS.maxDepth) throw new LexicalSearchError('LIMIT_EXCEEDED')
        if (blockTypes.has(node.type)) {
          const id = node.attrs?.blockId
          if (!isBlockId(id) || seen.has(id)) valid = false
          else seen.add(id)
        }
        node.content?.forEach(child => check(child, depth + 1))
      }
      check(page.content, 0)
      if (!valid) { this.unsupportedDocumentIds.add(page.id); continue }
      const walk = (node: IdentityNode) => {
        const id = isBlockId(node.attrs?.blockId) ? node.attrs.blockId : null
        if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) add(inlineText(node, () => this.unsupportedDocumentIds.add(page.id)), 'body', id)
        else if (node.type === 'mathBlock' || node.type === 'mermaid') {
          const text = node.attrs?.[node.type === 'mathBlock' ? 'latex' : 'code']
          if (typeof text === 'string') add(text, 'body', id)
        } else if (node.type === 'image') {
          if (typeof node.attrs?.alt === 'string') add(node.attrs.alt, 'body', id)
        } else {
          if (node.type !== 'doc' && !blockTypes.has(node.type)) this.unsupportedDocumentIds.add(page.id)
          node.content?.forEach(walk)
        }
      }
      walk(page.content)
    }
  }
  statistics() { return { passages: this.units.length, terms: this.postings.size, documents: this.documentTerms.size } }

  search(query: string, mode: SearchMode): LexicalMatch[] {
    if (!query.trim() || !['keywords', 'phrase', 'literal'].includes(mode)) throw new LexicalSearchError('INVALID_ARGUMENT')
    const terms = tokenize(query).map(token => token.term)
    if (mode !== 'literal' && !terms.length) throw new LexicalSearchError('INVALID_ARGUMENT')
    const unique = [...new Set(terms)]
    const candidates = new Set<number>()
    if (mode === 'literal') this.units.forEach((_unit, id) => candidates.add(id))
    else for (const term of unique) for (const id of this.postings.get(term)?.keys() ?? []) candidates.add(id)
    const result: LexicalMatch[] = []
    for (const id of candidates) {
      const unit = this.units[id]
      let from = -1, to = -1, matched = 0, frequency = 0
      if (mode === 'literal') {
        from = unit.text.indexOf(query); to = from + query.length; matched = 1; frequency = 1
      } else if (mode === 'phrase') {
        const position = (this.postings.get(terms[0])?.get(id) ?? []).find(start => terms.every((term, offset) => unit.tokens[start + offset]?.term === term))
        if (position !== undefined) { from = unit.tokens[position].from; to = unit.tokens[position + terms.length - 1].to; matched = terms.length; frequency = 1 }
      } else {
        // AND applies to the document across body/title/tags; passages identify
        // exact contributing blocks rather than inventing cross-column ranges.
        if (!unique.every(term => this.documentTerms.get(unit.documentId)?.has(term))) continue
        for (const term of unique) {
          const positions = this.postings.get(term)?.get(id) ?? []
          if (!positions.length) continue
          matched++; frequency += positions.length
          const first = unit.tokens[positions[0]]
          if (from < 0 || first.from < from) { from = first.from; to = first.to }
        }
      }
      if (from < 0) continue
      const weight = unit.source === 'title' ? 10 : unit.source === 'tag' ? 5 : 1
      result.push({ ...unit, score: weight * (matched + Math.min(frequency, 10) / 10), from, to })
    }
    return result.sort((a, b) => b.score - a.score || (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.order - b.order))
  }
}

/** Slice original source in Unicode code points; never slice using normalized
 * string offsets. No ellipsis or generated text is inserted into the passage. */
export function sourcePassage(match: LexicalMatch, maxChars: number): string | null {
  const source = [...match.text]
  const from = [...match.text.slice(0, match.from)].length
  const to = [...match.text.slice(0, match.to)].length
  const anchor = Math.min(to - from, 4096)
  if (anchor > maxChars) return null
  const length = Math.min(maxChars, 4096, Math.max(512, anchor))
  const start = Math.max(0, Math.min(from - Math.floor((length - anchor) / 2), source.length - length))
  return source.slice(start, start + length).join('')
}
