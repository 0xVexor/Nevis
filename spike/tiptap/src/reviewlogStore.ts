// Storage of the review log (the vault's kv/reviewlog.json).

export const deviceId = () => {
  try {
    return localStorage.getItem('not.device') ?? (localStorage.setItem('not.device', crypto.randomUUID()), localStorage.getItem('not.device')!)
  } catch {
    return 'device'
  }
}
