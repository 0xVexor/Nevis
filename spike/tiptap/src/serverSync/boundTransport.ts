/** A vault switch invalidates the operation even when a request already reached
 * the server. Callers must resolve such ambiguous outcomes using retry keys. */
export function bindTransportToVault(transport: typeof fetch, assertVault: () => Promise<void>): typeof fetch {
  return async (request, options) => {
    await assertVault()
    const response = await transport(request, options)
    await assertVault()
    return response
  }
}
