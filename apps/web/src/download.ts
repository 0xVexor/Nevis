/** Hands bytes to the browser as a file download. */
export function download(bytes: Uint8Array, name: string, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.rel = 'noopener'
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
