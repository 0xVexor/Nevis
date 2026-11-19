// A user setting kept in the vault (tasks inbox, review log, saved searches) that is never saved over what it could not read.
// Free of the desktop bindings (read and save are injected) so it can be tested in Node.
//
// `base` is the stored value the in-memory value descends from. A save sends it with the edit so the backend can merge with
// what is on disk now (another device may have synced a newer one); the merged result is adopted.

export type KvState<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; value: T }

export interface KvStoreOptions<T> {
  /** The stored value; undefined / null = nothing stored yet. Rejects when the file is unreadable. */
  read: () => Promise<unknown>
  /** Saves `next` merged with what is stored; resolves with the merged value to adopt. */
  save: (base: T | null, next: T) => Promise<unknown>
  /** Returns the value when the stored data has the expected shape, throws otherwise. */
  validate: (stored: unknown) => T
  /** What a key with nothing stored holds. */
  empty: T
  /** A save failed but the value in memory is kept (it is tried again with the next edit). */
  onSaveError?: (error: unknown) => void
}

/** The backend refuses to merge with a file it cannot read; nothing was written. */
export const isUnreadable = (error: unknown) => /unreadable_setting|invalid_user_setting|invalid_preferences/.test(String(error))

export function createKvStore<T>(o: KvStoreOptions<T>) {
  let state: KvState<T> = { status: 'loading' }
  let base: T | null = null
  let edits = 0 // counts edits: a read or save that finds it changed must not replace newer in-memory data
  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (next: KvState<T>) => {
    state = next
    listeners.forEach((l) => l())
  }

  /** Reads the stored value. Never throws: a failed read is the error state, which refuses edits and saves. */
  const load = async () => {
    await queue
    const seen = edits
    try {
      const stored = await o.read()
      if (disposed || seen !== edits) return // edited meanwhile: those edits are saved against what is on disk
      if (stored === undefined || stored === null) {
        base = null
        set({ status: 'ready', value: o.empty })
      } else {
        const value = o.validate(stored)
        base = value
        set({ status: 'ready', value })
      }
    } catch (error) {
      if (!disposed && seen === edits) set({ status: 'error', error })
    }
  }

  const persist = (next: T) => {
    const mine = edits
    const sent = next
    queue = queue.then(async () => {
      if (state.status !== 'ready') return
      try {
        const merged = o.validate(await o.save(base, sent))
        if (edits === mine) {
          base = merged // no newer edit: the merged value is both what is stored and what is shown
          set({ status: 'ready', value: merged })
        } else base = sent // a newer edit was built from `sent`, not from `merged`: the next save merges with the disk itself
      } catch (error) {
        if (isUnreadable(error)) set({ status: 'error', error }) // nothing was written; reading again decides
        o.onSaveError?.(error) // `base` stays: the next save starts from the same ancestor
      }
    })
  }

  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    load,
    /** Changes the value from its latest state and saves it. Does nothing (returns false) until the stored value was read. */
    update(change: (current: T) => T): boolean {
      if (state.status !== 'ready') return false
      edits++
      const next = change(state.value)
      set({ status: 'ready', value: next })
      persist(next)
      return true
    },
    /** Resolves when every save queued so far has finished. */
    settled: () => queue,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

/** For a setting that is a list: a stored value of any other shape is unreadable, not an empty list. */
export function validateList<T>(stored: unknown): T[] {
  if (!Array.isArray(stored)) throw new Error('The stored value is not a list')
  return stored
}

export type KvStore<T> = ReturnType<typeof createKvStore<T>>
