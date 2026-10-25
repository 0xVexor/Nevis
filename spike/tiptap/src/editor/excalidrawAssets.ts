// Excalidraw reads this when it is first evaluated, so this module must be imported before the library.
// Fonts are served from the app itself (public/excalidraw-assets), so drawing works offline.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', document.baseURI).href

// Excalidraw picks images through browser-fs-access, which prefers the File System Access API. Some webviews hand back a file
// handle whose getFile() is refused (NotAllowedError), so a chosen image never arrives. Without that API the library uses a plain
// <input type="file">, which works everywhere. (The app itself only uses showDirectoryPicker.)
try {
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
} catch {
  /* not configurable: the library keeps its default */
}
