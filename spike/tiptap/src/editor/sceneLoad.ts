// Outcome of reading a stored drawing. Kept free of the Excalidraw library and the file store (both injected) so it can be tested in Node.

export type SceneLoad<S> =
  | { status: 'empty' } // no drawing stored yet: a blank, editable canvas
  | { status: 'ok'; scene: S }
  | { status: 'missing' } // an id is set but its file is not here (e.g. a synced page arrived before its files)
  | { status: 'unreadable'; error: unknown } // the file is here but cannot be read or understood

/** Reads the scene JSON of file `id`. Never throws: every failure is an outcome, so the caller can refuse to edit and to save over it. */
export async function readScene<S>(id: string, readBlob: (id: string) => Promise<Blob | null>, restore: (data: any) => S): Promise<SceneLoad<S>> {
  if (!id) return { status: 'empty' }
  try {
    const blob = await readBlob(id)
    if (!blob) return { status: 'missing' }
    return { status: 'ok', scene: restore(JSON.parse(await blob.text())) }
  } catch (error) {
    console.error('[drawing] Could not read the stored scene', id, error)
    return { status: 'unreadable', error }
  }
}
