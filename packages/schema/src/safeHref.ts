// Content synced from other devices is untrusted (a page is data somebody wrote). A link may only point to http, https, mailto or tel:
// never javascript:, data:, vbscript:, file: or anything the browser could run. The same function guards typing a link, pasting
// HTML and Markdown, and rendering.
const OK = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export function isSafeHref(href: string): boolean {
  const h = href.replace(/[\u0000-\u001f\u007f\s]+/g, '') // browsers ignore tabs and newlines inside a scheme: "java\tscript:" must not slip through
  if (h === '') return false
  let url: URL
  try { url = new URL(h) } catch { return false } // no scheme (relative) is refused: a note has no base address
  return OK.has(url.protocol)
}
