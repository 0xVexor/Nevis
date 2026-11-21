// Which addresses an image may have. Synced pages are untrusted data: an image `src` is '' (a placeholder) or an https URL, never a
// `data:` URL (it would make one op huge and carry anything) and never plain http from the internet (the content security policy
// refuses it, so it would only be a broken image). Attachments (M9) will replace this for files.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for an http:// address that the app cannot load (anything but this computer). */
export function isBlockedHttpUrl(address: string): boolean {
  let url: URL
  try { url = new URL(address) } catch { return false }
  return url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)
}

export { safeImageSrc } from '@nevis/schema'
