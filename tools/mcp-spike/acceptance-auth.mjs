import { execFileSync } from 'node:child_process'

export function acceptanceEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use only the displayed loopback MCP endpoint')
  return url
}
export function acceptanceToken(grantId, timeoutMs = 60000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid credential-read timeout')
  if (!/^[a-f0-9-]{36}$/i.test(grantId ?? '')) throw new Error('Expected the acceptance grant ID')
  let token = process.env.NEVIS_ACCEPTANCE_TOKEN
  if (!token) {
    try { token = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'com.vexor.noviq.mcp', '-a', grantId, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim() }
    catch { throw new Error('Temporary test credential unavailable. Handle the macOS Keychain prompt yourself and rerun when ready.') }
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid temporary test credential')
  return token
}
