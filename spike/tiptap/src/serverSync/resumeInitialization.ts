import { bootstrapDocument } from './bootstrap.ts'
import type { InitializationScope } from './initializationStore.ts'

/** Only load previously durable bytes. Never regenerate them after an uncertain response. */
export async function resumeInitialization(
  scope: InitializationScope,
  store: { load(scope: InitializationScope): Promise<Uint8Array | null> },
  sessionToken: string,
  options: { signal?: AbortSignal; send?: typeof fetch } = {},
): Promise<void> {
  const boundScope = { ...scope }
  const bytes = await store.load(boundScope)
  if (!bytes) throw new Error('Initialization has not been prepared')
  await bootstrapDocument({
    collaborationOrigin: boundScope.collaborationOrigin,
    documentId: boundScope.documentId,
    sessionToken,
    initialUpdate: bytes,
    signal: options.signal,
  }, options.send)
}
