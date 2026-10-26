export interface AvailableUpdate {
  version: string
  notes: string
  publishedAt: string | null
  prerelease: boolean
}
export interface UpdateProgress { downloaded: number; total: number | null }
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'saving' | 'installing' | 'error'
export interface UpdateState {
  phase: UpdatePhase
  update: AvailableUpdate | null
  progress: UpdateProgress
  error: string
  notice: boolean
  dialog: boolean
}
export interface UpdateDeps {
  includePrerelease(): boolean
  check(includePrerelease: boolean): Promise<AvailableUpdate | null>
  download(version: string, progress: (p: UpdateProgress) => void): Promise<void>
  save(): Promise<void>
  install(version: string): Promise<void>
}
export const updateBusy = (phase: UpdatePhase) => ['checking', 'downloading', 'saving', 'installing'].includes(phase)

/** One controller across navigation: checking and installation cannot overlap. */
export function createUpdateController(deps: UpdateDeps) {
  let state: UpdateState = { phase: 'idle', update: null, progress: { downloaded: 0, total: null }, error: '', notice: false, dialog: false }
  const listeners = new Set<() => void>()
  const dismissed = new Set<string>() // remind again next app session, not on every background check
  const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach((f) => f()) }
  let checking = false
  let manualRequested = false
  const controller = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn) },
    async check(manual = false) {
      manualRequested ||= manual
      if (checking || updateBusy(state.phase) || state.phase === 'ready' || state.dialog) return
      checking = true
      const channel = deps.includePrerelease()
      set({ phase: 'checking', update: null, notice: false, error: '' })
      try {
        const update = await deps.check(channel)
        if (channel !== deps.includePrerelease()) return
        const show = manualRequested
        set({ phase: update ? 'available' : 'current', update, notice: !!update && !show && !dismissed.has(update.version), dialog: !!update && show })
      } catch (e) {
        if (channel === deps.includePrerelease()) set({ phase: 'error', error: String(e), update: null, notice: false })
      } finally {
        checking = false
        if (channel !== deps.includePrerelease()) {
          set({ phase: 'idle' })
          void controller.check(manualRequested)
        } else manualRequested = false
      }
    },
    channelChanged() {
      if (checking) return // the in-flight result is discarded and checked again
      if (updateBusy(state.phase)) return
      set({ phase: 'idle', update: null, notice: false, dialog: false })
      void controller.check()
    },
    open() { if (state.update) set({ dialog: true, notice: false }) },
    close() { if (!updateBusy(state.phase)) set({ dialog: false }) },
    dismiss() {
      if (state.update) dismissed.add(state.update.version)
      set({ notice: false, dialog: false })
    },
    async download() {
      const update = state.update
      if (!update || updateBusy(state.phase)) return
      if (update.prerelease && !deps.includePrerelease()) return controller.channelChanged()
      set({ phase: 'downloading', error: '', progress: { downloaded: 0, total: null }, dialog: true, notice: false })
      try {
        await deps.download(update.version, (progress) => set({ progress }))
        set({ phase: 'ready' })
      } catch (e) { set({ phase: 'error', error: String(e) }) }
    },
    async install() {
      const update = state.update
      if (!update || state.phase !== 'ready') return
      set({ phase: 'saving', error: '', dialog: true })
      try {
        await deps.save()
      } catch {
        set({ phase: 'ready', error: 'UPDATE_SAVE_FAILED' })
        return
      }
      set({ phase: 'installing' })
      try { await deps.install(update.version) }
      catch (e) { set({ phase: 'error', error: String(e) }) }
    },
  }
  return controller
}
