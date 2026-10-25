// Instant change notification. A device holds one request open ("long poll"): the server answers it the moment
// another device commits, or after `ms` with "nothing new". This works through every proxy and flaky network a plain
// HTTPS request works through, which a WebSocket does not always do.

export class Hub {
  constructor() {
    this.waiters = new Map() // vault id -> Set of wake functions
  }

  /** Wakes everyone waiting on the vault. */
  notify(vaultId) {
    const set = this.waiters.get(vaultId)
    if (!set) return
    this.waiters.delete(vaultId)
    for (const wake of set) wake()
  }

  /** Resolves when the vault changes, after `ms`, or when `res` (the HTTP response) is closed by the client. */
  wait(vaultId, ms, res) {
    return new Promise((resolve) => {
      let timer
      const done = () => {
        clearTimeout(timer)
        res?.off?.('close', done)
        this.waiters.get(vaultId)?.delete(done)
        if (this.waiters.get(vaultId)?.size === 0) this.waiters.delete(vaultId)
        resolve()
      }
      timer = setTimeout(done, ms)
      res?.once?.('close', done)
      if (!this.waiters.has(vaultId)) this.waiters.set(vaultId, new Set())
      this.waiters.get(vaultId).add(done)
    })
  }

  /** Lets every waiting request go (server shutdown). */
  releaseAll() {
    for (const id of [...this.waiters.keys()]) this.notify(id)
  }

  get size() {
    let n = 0
    for (const s of this.waiters.values()) n += s.size
    return n
  }
}
