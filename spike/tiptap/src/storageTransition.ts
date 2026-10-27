interface Drainable {
  pauseWrites(): () => void
  flushed(): Promise<void>
}
interface TransitionOptions {
  saveEditors(): Promise<void>
  repository: Drainable
  coordinator?: Drainable
  freeze(): void
  thaw(): void
}

let transitioning = false

/** Stop new producers before the final drain; already accepted work can finish. */
export async function prepareStorageTransition(options: TransitionOptions): Promise<() => void> {
  if (transitioning) throw new Error('A workspace switch or update is already running.')
  transitioning = true
  let resumed = false
  let resumeDatabase: (() => void) | undefined, resumeRepository: (() => void) | undefined
  const resume = () => {
    if (resumed) return
    resumed = true
    options.thaw()
    resumeRepository?.()
    resumeDatabase?.()
    transitioning = false
  }
  try {
    await options.saveEditors()
    resumeDatabase = options.coordinator?.pauseWrites()
    await options.coordinator?.flushed()
    resumeRepository = options.repository.pauseWrites()
    await options.repository.flushed()
    options.freeze()
    return resume
  } catch (error) { resume(); throw error }
}
