import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri, storageFrozen, vaultInfo } from '../db'
import { repo } from '../store'
import { createDocumentReadRuntime } from '../platform/documentEnvironment'
import { McpDocumentSession } from '../documents/mcp'
import type { McpConnection, McpPolicy } from '../documents/mcp'

export interface McpStatus { active: boolean; ready: boolean; endpoint: string | null; connection: McpConnection | null; pending: number }
export const connectionStatus = () => invoke<McpStatus>('mcp_status')
export const disableConnection = () => invoke<void>('mcp_disable')
export async function enableConnection(policy: McpPolicy) {
  const { id } = await vaultInfo()
  return invoke<McpStatus>('mcp_enable', { expectedVaultId: id, policy })
}
export async function copyConnection(status: McpStatus) {
  if (!status.active || !status.connection || !status.endpoint) throw new Error('Connection disabled')
  const token = await invoke<string>('mcp_credential', { expectedVaultId: status.connection.vaultId })
  await navigator.clipboard.writeText(JSON.stringify({ url: status.endpoint, headers: { Authorization: `Bearer ${token}` } }, null, 2))
}

/** Start after the fixed-vault repository is initialized. No credential enters events or stored web state. */
export async function startMcpBridge() {
  if (!isTauri) return () => {}
  const expectedVaultId = (await vaultInfo()).id, owner = crypto.randomUUID(), runtime = createDocumentReadRuntime()
  let alive = true
  const sessions = new Map<string, McpDocumentSession>(), cancelled = new Set<string>()
  const stops: (() => void)[] = []
  const close = (revision?: string) => {
    for (const [id, session] of sessions) if (!revision || id === revision) { session.close(); sessions.delete(id) }
  }
  try {
    stops.push(await listen<{ revision?: string }>('mcp-state', event => { if (event.payload.revision) close(event.payload.revision) }))
    stops.push(await listen<{ requestId: string }>('mcp-cancel', event => {
      while (cancelled.size >= 128) cancelled.delete(cancelled.values().next().value!)
      cancelled.add(event.payload.requestId)
    }))
    stops.push(await listen<{ requestId: string; expiresAt: number; connection: McpConnection; message: unknown }>('mcp-request', async event => {
      const { requestId, expiresAt, connection, message } = event.payload
      if (!alive || connection.vaultId !== expectedVaultId || storageFrozen()) return
      let session = sessions.get(connection.revision)
      if (!session) {
        close()
        session = new McpDocumentSession(repo, connection, runtime, () => alive && !storageFrozen())
        sessions.set(connection.revision, session)
      }
      let result
      try { result = await session.dispatch(message, { id: requestId, expiresAt, active: () => !cancelled.has(requestId) }) }
      catch { result = { jsonrpc: '2.0', id: (message as any)?.id ?? null, error: { code: -32000, message: 'App unavailable' } } }
      cancelled.delete(requestId)
      try { await invoke('mcp_reply', { requestId, revision: connection.revision, result }) } catch { /* revoked, expired or closed; do not log note content */ }
    }))
    const ready = async () => {
      if (!alive || storageFrozen()) return
      try { await invoke('mcp_ready', { expectedVaultId, owner }) }
      catch { close() }
    }
    await ready()
    const timer = window.setInterval(() => void ready(), 3000)
    const stop = () => { alive = false; window.clearInterval(timer); close(); stops.forEach(stop => stop()) }
    window.addEventListener('beforeunload', stop, { once: true })
    return stop
  } catch {
    alive = false; close(); stops.forEach(stop => stop())
    return () => {}
  }
}
