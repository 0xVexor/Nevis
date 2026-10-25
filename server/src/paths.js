// Which paths a vault may contain. The same places the desktop app syncs (spike/tiptap/src-tauri/src/sync/mod.rs, ROOTS),
// refused early on the server so that a hostile or buggy client cannot make a path that breaks another operating system.

const ROOTS = new Set(['pages', 'files', 'history', 'kv', '.trash'])
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const BAD_CHARS = /[<>"|?*:\\\x00-\x1f\x7f]/

export const MAX_PATH = 240

/** `null` when the path is fine, otherwise a short reason. */
export function checkPath(p) {
  if (typeof p !== 'string' || p.length === 0) return 'empty'
  if (p.length > MAX_PATH) return 'too_long'
  if (p !== p.normalize('NFC')) return 'not_nfc'
  if (p.startsWith('/')) return 'absolute'
  if (BAD_CHARS.test(p)) return 'bad_char'
  if (p === '.noviq/vault.json') return null
  const parts = p.split('/')
  if (parts.length < 2 || !ROOTS.has(parts[0])) return 'outside_vault'
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return 'bad_segment'
    if (seg.endsWith('.') || seg.endsWith(' ')) return 'bad_segment'
    if (RESERVED.test(seg)) return 'reserved_name'
    if (seg.startsWith('.') && seg.endsWith('.tmp')) return 'temp_file'
  }
  return null
}

/** Two paths that differ only in letter case are one file on Windows and macOS, so the server treats them as one. */
export const foldCase = (p) => p.toLowerCase()
