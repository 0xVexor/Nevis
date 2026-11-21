// Persian-aware text normalization and tokenization for search (ADR-0010). ONE implementation for index time and query time, on every
// platform. Stored text is never changed: this only decides what is compared. A change to any rule here is a `NORM_VERSION` bump, which
// makes every device rebuild its derived index.
export const NORM_VERSION = 1

const LETTERS: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'ە': 'ه', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', 'آ': 'ا', 'ؤ': 'و', 'ئ': 'ی', '٫': '.', '٬': ',',
}
const ZWNJ = '‌'
// diacritics, dagger alif, tatweel, direction marks, BOM; ZWJ is dropped (it joins letters, it does not separate words)
const DROP = /[ً-ٰٟـ‍‎‏‪-‮⁦-⁩﻿؜]/g

/** The comparison form of a text: NFKC, letters unified, digits ASCII, marks removed, lower case. ZWNJ is kept (the tokenizer decides). */
export function normalizeForSearch(text: string): string {
  let s = text.normalize('NFKC').replace(DROP, '')
  s = s.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
  s = Array.from(s, c => LETTERS[c] ?? c).join('')
  return s.toLowerCase()
}

const WORD = /[\p{L}\p{N}‌]+/gu

/** The index terms of a text. A word with ZWNJ gives THREE forms: joined (`میخواهم`), and each part (`می`, `خواهم`); so "می‌خواهم",
 *  "میخواهم", "می خواهم" and "خواهم" all find it. Anything that is not a letter or a digit separates words. Digits with a decimal or
 *  thousands mark (`1.5`, `1,000`) stay one term. */
export function tokenize(text: string): string[] {
  const s = normalizeForSearch(text).replace(/(\d)[.,](?=\d)/g, '$1\u0001')
  const out: string[] = []
  for (const m of s.matchAll(WORD)) {
    const w = m[0].replace(/\u0001/g, '.')
    const parts = w.split(ZWNJ).filter(Boolean)
    if (!parts.length) continue
    if (parts.length === 1) { out.push(parts[0]!); continue }
    out.push(parts.join(''), ...parts)
  }
  return out
}

/** What a query means: one group per word, each group a list of ALTERNATIVES, each alternative a list of terms that must all be found.
 *  A word with ZWNJ is `[joined]` OR `[part1, part2, ...]`. A document matches when every group has an alternative whose terms are all
 *  found (as prefixes). So "می‌خواهم" finds a text that has it with ZWNJ, joined, or with a space. */
export function queryGroups(query: string): string[][][] {
  const s = normalizeForSearch(query).replace(/(\d)[.,](?=\d)/g, '$1\u0001')
  const groups: string[][][] = []
  for (const m of s.matchAll(WORD)) {
    const parts = m[0].replace(/\u0001/g, '.').split(ZWNJ).filter(Boolean)
    if (!parts.length) continue
    groups.push(parts.length === 1 ? [[parts[0]!]] : [[parts.join('')], parts])
  }
  return groups
}
