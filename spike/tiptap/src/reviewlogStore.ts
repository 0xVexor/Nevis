import { kvGet, kvSet } from './db'
import { bump, dayKey, type ReviewLog } from './reviewlog'

// Storage of the review log (the vault's kv/reviewlog.json, synced between devices).

export const deviceId = () => {
  try {
    return localStorage.getItem('not.device') ?? (localStorage.setItem('not.device', crypto.randomUUID()), localStorage.getItem('not.device')!)
  } catch {
    return 'device'
  }
}

export const loadLog = async (): Promise<ReviewLog> => (await kvGet<ReviewLog>('reviewlog')) ?? {}

export async function recordReview(log: ReviewLog): Promise<ReviewLog> {
  const next = bump(log, deviceId(), dayKey(Date.now()))
  await kvSet('reviewlog', next)
  return next
}
