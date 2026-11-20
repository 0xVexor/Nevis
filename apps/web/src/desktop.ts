// The desktop shell's side of the web bundle (ADR-0013): when the page runs inside Tauri, the store is SQLite in Rust and every
// request to the server is made by Rust, which adds the device token itself. This file is the only place that knows about Tauri.
import { TauriStore } from '@nevis/store-tauri'
import type { Store } from '@nevis/core'

type Internals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }
const internals = (): Internals => (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__

export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => internals().invoke(cmd, args)

export interface AppInfo { mode: 'normal' | 'selftest' | 'bench' | 'typing' | 'sync'; env: { user: string | null; ws: string | null; phase: string | null }; dataDir: string; server: string | null; hasToken: boolean; blocked: number; verify: boolean; benchSeconds: number }
export const appInfo = (): Promise<AppInfo> => invoke('app_info') as Promise<AppInfo>
export const setServer = (url: string): Promise<string> => invoke('server_set', { url }) as Promise<string>

export const openDesktopStore = (ws: string, onCommit?: (ms: number, ops: number) => void): Store => new TauriStore({ ws, invoke, onCommit })

let seq = 0
/** `fetch` for `/v1/...` paths, made by Rust. Aborting cancels the request in Rust (the long-poll must not outlive sign-out). */
export const desktopFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const signal = init?.signal ?? undefined
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const requestId = `r${++seq}`
  const cancel = () => void invoke('net_cancel', { requestId })
  signal?.addEventListener('abort', cancel)
  try {
    const r = (await invoke('net_request', { method: init?.method ?? 'GET', path: String(input), body: typeof init?.body === 'string' ? init.body : null, requestId })) as { status: number; text: string }
    return new Response(r.text, { status: r.status })
  } catch (e) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    throw new TypeError(String(e))
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}) as typeof fetch

/** Closing the window: Rust asks the page to write what it holds and push the outbox, and waits (at most 5 s) for `done`. */
export async function onWindowFlush(flush: () => Promise<unknown>): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  const off = await listen('nevis://flush', () => { void flush().finally(() => invoke('flush_done')) })
  await invoke('flush_ready')
  return off
}
