export function acceptanceEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use only the displayed loopback MCP endpoint')
  return url
}
/** Clients receive a copied session token, never direct access to an OS credential store. */
export function acceptanceToken(grantId, endpoint) {
  if (!/^[a-f0-9-]{36}$/i.test(grantId ?? '')) throw new Error('Expected the acceptance grant ID')
  let token = process.env.NEVIS_ACCEPTANCE_TOKEN
  if (process.env.NEVIS_ACCEPTANCE_CONNECTION) {
    let details
    try { details = JSON.parse(process.env.NEVIS_ACCEPTANCE_CONNECTION) }
    catch { throw new Error('Invalid copied connection details') }
    const copiedUrl = acceptanceEndpoint(details.url)
    if (endpoint && copiedUrl.href !== acceptanceEndpoint(endpoint).href) throw new Error('Copied connection endpoint does not match')
    const authorization = details.headers?.Authorization
    if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/i.test(authorization)) throw new Error('Invalid copied connection credential')
    token ??= authorization.slice(7)
  }
  if (!token) throw new Error('Copy Nevis connection details into NEVIS_ACCEPTANCE_CONNECTION or supply NEVIS_ACCEPTANCE_TOKEN; no Keychain access is used')
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid temporary test credential')
  return token
}
