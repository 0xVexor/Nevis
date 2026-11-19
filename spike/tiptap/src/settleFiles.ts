// Reads many files without letting one that is not here (a sync has not delivered its bytes yet) fail the whole job.
// Free of the file store so it can be tested in Node.

export interface SettledFiles<F> {
  files: F[]
  /** how many files were listed but could not be read */
  missing: number
}

export async function settleFiles<M, F>(metas: M[], read: (meta: M) => Promise<F>): Promise<SettledFiles<F>> {
  const results = await Promise.allSettled(metas.map(read))
  const files: F[] = []
  for (const r of results) if (r.status === 'fulfilled') files.push(r.value)
  return { files, missing: results.length - files.length }
}
