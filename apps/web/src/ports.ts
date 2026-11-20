// The browser's side of the core's ports: Web Locks and BroadcastChannel.
import type { ChannelPort, LockPort } from '@nevis/core'

export const webLocks: LockPort = {
  request: (name, signal, held) => navigator.locks.request(name, { signal }, held).then(() => undefined, e => { if ((e as DOMException).name !== 'AbortError') throw e }),
}

export function webChannel(name: string): ChannelPort {
  const ch = new BroadcastChannel(name)
  return {
    post: m => ch.postMessage(m),
    onMessage: cb => { const h = (e: MessageEvent) => cb(e.data); ch.addEventListener('message', h); return () => ch.removeEventListener('message', h) },
    close: () => ch.close(),
  }
}
