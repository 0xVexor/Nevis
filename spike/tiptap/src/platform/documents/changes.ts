let publisher: BroadcastChannel | null = null

/** Advisory notification only. Every query still reconciles persisted content. */
export function publishDocumentChange() {
  try {
    if (typeof BroadcastChannel === 'undefined') return
    publisher ??= new BroadcastChannel('nevis-documents')
    publisher.postMessage('committed')
  } catch { /* notifications cannot turn a successful save into a failure */ }
}
