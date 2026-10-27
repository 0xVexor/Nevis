// Storage cache writes notify the vault preference writer immediately. Its allowlist excludes device-local fields.
export function setPreference(key: string, value: string) {
  localStorage.setItem(key, value)
  window.dispatchEvent(new Event('preferences-edit'))
}
export function removePreference(key: string) {
  localStorage.removeItem(key)
  window.dispatchEvent(new Event('preferences-edit'))
}
