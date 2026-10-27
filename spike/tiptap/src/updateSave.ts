// Editors register their pending saves so installation waits for their debounce and async work.
const pending = new Set<Promise<unknown>>()
export const trackPendingSave = <T>(work: Promise<T>): Promise<T> => {
  pending.add(work)
  // Registered savers retain retryable failures; track work across unmounts.
  void work.then(() => pending.delete(work), () => pending.delete(work))
  return work
}

const savers = new Set<() => void | Promise<unknown>>()
export const registerUpdateSave = (save: () => void | Promise<unknown>) => {
  savers.add(save)
  return () => {
    savers.delete(save)
    // Keep a detached editor's save function until its data is acknowledged.
    // Failures remain retryable when the next workspace switch/update drains.
    const detached = async () => { await save(); savers.delete(detached) }
    savers.add(detached)
    void detached().catch(() => {})
  }
}
export const saveBeforeUpdate = async () => {
  for (const save of [...savers]) await save()
  while (pending.size) await Promise.all([...pending])
}
