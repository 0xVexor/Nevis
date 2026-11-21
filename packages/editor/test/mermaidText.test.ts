import { describe, expect, it } from 'vitest'
import { cleanMermaid, looksLikeMermaid } from '../src/mermaidText'
import { normalizeFa } from '../src/findNormalize'

describe('mermaid text', () => {
  it('recognizes diagram source and not prose that starts with a diagram word', () => {
    expect(looksLikeMermaid('graph TD\n  A --> B')).toBe(true)
    expect(looksLikeMermaid('sequenceDiagram\n  A->>B: hi')).toBe(true)
    expect(looksLikeMermaid('pie\nsome ordinary sentence')).toBe(false)
    expect(looksLikeMermaid('graph')).toBe(false)
    expect(looksLikeMermaid('hello\nworld')).toBe(false)
  })
  it('repairs what a word processor or a chat did to the arrows and quotes', () => {
    expect(cleanMermaid('A –> B\nC —> D\nE \u2212> F')).toBe('A --> B\nC --> D\nE --> F')
    expect(cleanMermaid('A[“x”] --> B[‘y’]')).toBe('A["x"] --> B[\'y\']')
    expect(cleanMermaid('a\u00a0b')).toBe('a b')
  })
})

describe('find normalization', () => {
  it('Arabic letters, ZWNJ, digits and diacritics match the Persian forms', () => {
    expect(normalizeFa('كلاس')).toBe(normalizeFa('کلاس'))
    expect(normalizeFa('می‌روم')).toBe(normalizeFa('می روم'))
    expect(normalizeFa('۱۲۳')).toBe('123')
    expect(normalizeFa('٤٥٦')).toBe('456')
    expect(normalizeFa('مَکتَب')).toBe(normalizeFa('مکتب'))
    expect(normalizeFa('Hello')).toBe('hello')
  })
})
