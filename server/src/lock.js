// "Run exactly one instance." The server serializes every write inside one process and keeps its index in one SQLite file;
// two instances would each have their own idea of the order of events. A heartbeat in the storage makes a second instance
// notice the first one and refuse to start (after giving a stopping one a little time to let go, as in a rolling deploy).

import { randomUUID } from 'node:crypto'

const KEY = '_lock/instance.json'

async function read(storage) {
  try {
    const b = await storage.read(KEY)
    return b ? JSON.parse(b.toString('utf8')) : null
  } catch {
    return null
  }
}

const write = (storage, id, at) => storage.put(KEY, Buffer.from(JSON.stringify({ id, at })))

export async function acquireLock(storage, { id = randomUUID(), now = () => Date.now(), waitMs = 35_000, staleMs = 30_000, stepMs = 2_000, settleMs = 1_500, beatMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now()
  for (;;) {
    const cur = await read(storage)
    if (!cur || cur.id === id || now() - cur.at > staleMs) break
    if (now() - t0 > waitMs) throw new Error(`another server instance (${cur.id}) is running against this storage; run exactly one instance`)
    await sleep(stepMs)
  }
  await write(storage, id, now())
  await sleep(settleMs) // two instances starting together both write; the later write wins and the other one sees it
  const after = await read(storage)
  if (after?.id !== id) throw new Error(`another server instance (${after?.id}) started at the same time; run exactly one instance`)
  const beat = setInterval(() => void write(storage, id, now()).catch(() => {}), beatMs)
  beat.unref?.()
  return {
    id,
    async release() {
      clearInterval(beat)
      const cur = await read(storage)
      if (cur?.id === id) await storage.del(KEY)
    },
  }
}
