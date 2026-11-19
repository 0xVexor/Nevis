// Which addresses "Image from the web" accepts. The app's content security policy allows https: for images and fetches (and
// http only for the local machine), so an http:// address from the internet would end as a broken image.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for an http:// address that the app cannot load (anything but this computer). */
export function isBlockedHttpUrl(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  return url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)
}
