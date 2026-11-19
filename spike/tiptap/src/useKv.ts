import { useEffect, useRef, useSyncExternalStore } from 'react'
import { kvGet, kvSave } from './db'
import { createKvStore, type KvState, type KvStore } from './kvStore'
import { showToast } from './ui'
import { t } from './i18n'

/**
 * A user setting of the vault as screen state. It is `loading` until read, `error` when the stored value could not be read
 * (read-only: `update` does nothing, so nothing is saved over it; `retry` reads again), and re-read when a sync changed the files.
 */
export function useKv<T>(key: string, validate: (stored: unknown) => T, empty: T): { state: KvState<T>; update: KvStore<T>['update']; retry: () => void } {
  const ref = useRef<KvStore<T>>(undefined)
  ref.current ??= createKvStore<T>({
    read: () => kvGet<unknown>(key),
    save: (base, next) => kvSave<unknown>(key, base, next),
    validate,
    empty,
    onSaveError: (e) => {
      console.error('save', key, e)
      showToast(t('Could not save. Your changes are still here.'))
    },
  })
  const store = ref.current
  const state = useSyncExternalStore(store.subscribe, store.get)
  useEffect(() => {
    void store.load()
    const reload = () => void store.load()
    window.addEventListener('external-change', reload) // a sync download: adopt it, so the next save does not overwrite it
    return () => window.removeEventListener('external-change', reload)
  }, [store])
  return { state, update: store.update, retry: () => void store.load() }
}
