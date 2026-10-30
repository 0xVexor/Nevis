import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri, storageFrozen, vaultInfo } from '../db'
import { repo } from '../store'
import { markdownToNodes } from '../io'
import { createDatabaseTools } from '../database/mcpTools'
import { getDatabase } from '../database/runtime'
import { createDocumentReadRuntime } from '../platform/documentEnvironment'
import { McpDocumentSession } from '../documents/mcp'
import type { McpConnection, McpPolicy } from '../documents/mcp'

export interface McpStatus { writesAvailable: boolean; active: boolean; ready: boolean; endpoint: string | null; connection: McpConnection | null; pending: number }
export const connectionStatus = () => invoke<McpStatus>('mcp_status')
export const disableConnection = () => invoke<void>('mcp_disable')
export async function enableConnection(policy: McpPolicy) {
  const { id } = await vaultInfo()
  return invoke<McpStatus>('mcp_enable', { expectedVaultId: id, policy })
}
export type AiClient = 'claude' | 'codex' | 'gemini'
/** Adds Nevis to the AI app's own settings file; returns the file that was changed. */
export const installClient = (client: AiClient) => invoke<string>('mcp_install_client', { client })
const writeClipboard = async (text: string) => {
  try { await navigator.clipboard.writeText(text) } catch {
    // The webview can refuse the async clipboard API; fall back to a selection copy.
    const box = document.createElement('textarea')
    box.value = text; box.style.position = 'fixed'; box.style.opacity = '0'
    document.body.appendChild(box); box.select()
    const ok = document.execCommand('copy'); box.remove()
    if (!ok) throw new Error('Clipboard unavailable')
  }
}
/** A ready-to-paste message for any AI app that is not listed: how to start the relay, plus the direct HTTP details while connected. */
export async function copyForAnyAi(status: McpStatus) {
  const setup = await invoke<{ command: string; args: string[] }>('mcp_setup_info')
  const lines = [
    'Add this MCP server so you can read and edit my Nevis notes.',
    '',
    'Option 1 (stdio, stays valid after Nevis restarts):',
    JSON.stringify({ mcpServers: { nevis: { command: setup.command, args: setup.args } } }, null, 2),
  ]
  if (status.active && status.connection && status.endpoint) {
    const token = await invoke<string>('mcp_credential', { expectedVaultId: status.connection.vaultId })
    lines.push('', 'Option 2 (Streamable HTTP, valid until Nevis restarts):', JSON.stringify({ url: status.endpoint, headers: { Authorization: `Bearer ${token}` } }, null, 2))
  }
  lines.push('', 'Start with get_editor_capabilities, then list_documents or search_documents. Nevis must be open.')
  await writeClipboard(lines.join('\n'))
}
export async function copyConnection(status: McpStatus) {
  if (!status.active || !status.connection || !status.endpoint) throw new Error('Connection disabled')
  const token = await invoke<string>('mcp_credential', { expectedVaultId: status.connection.vaultId })
  await writeClipboard(JSON.stringify({ url: status.endpoint, headers: { Authorization: `Bearer ${token}` } }, null, 2))
}

const databaseTools = createDatabaseTools(getDatabase)

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
        session = new McpDocumentSession(repo, connection, runtime, () => alive && !storageFrozen(), connection.writesAvailable === true, markdownToNodes, databaseTools)
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
    // the user left the connection on last time: switch it back on without a click
    try {
      const policy = await invoke<McpPolicy | null>('mcp_autostart', { expectedVaultId })
      if (policy && !(await connectionStatus()).active) await invoke('mcp_enable', { expectedVaultId, policy })
    } catch { /* stays off; the settings page shows the state */ }
    const timer = window.setInterval(() => void ready(), 3000)
    const stop = () => { alive = false; window.clearInterval(timer); close(); stops.forEach(stop => stop()) }
    window.addEventListener('beforeunload', stop, { once: true })
    return stop
  } catch {
    alive = false; close(); stops.forEach(stop => stop())
    return () => {}
  }
}
