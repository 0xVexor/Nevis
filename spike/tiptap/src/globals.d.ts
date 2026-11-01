interface Window {
  /** Set when a template is picked on one screen and applied once the new page has mounted. */
  __pendingTpl?: { pageId: string; id: string }
}

interface Window {
  /** File System Access API (Chromium and WebView2); not in TypeScript's DOM library yet. */
  showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>
}
