// Excalidraw's hand-drawn fonts have no Persian letters, so Persian text would be drawn in whatever font the system picks
// (different on every OS). Its font stack ends in the family "Xiaolai", so we register Vazirmatn under that name, limited to
// Arabic-script code points: Persian then looks the same everywhere, and Latin text keeps the hand-drawn font.
const FILE = 'fonts/Vazirmatn/Vazirmatn-arabic-400.woff2'
const RANGE = 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D'
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/

export const hasArabicScript = (text: string) => ARABIC_SCRIPT.test(text)

const fileUrl = () => new URL(FILE, new URL('./excalidraw-assets/', document.baseURI)).href

let face: Promise<void> | null = null
/** Registers the font for the page (so the canvas can draw with it). Never rejects: without it the system font is used. */
export function loadPersianFont(): Promise<void> {
  return (face ??= (async () => {
    const f = new FontFace('Xiaolai', `url(${fileUrl()})`, { unicodeRange: RANGE })
    document.fonts.add(await f.load())
  })().catch(() => undefined))
}

let css: Promise<string> | null = null
/** The same font as an inline @font-face, for the saved SVG picture (an <img> cannot use the page's fonts). */
export function persianFontCss(): Promise<string> {
  return (css ??= fetch(fileUrl())
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `@font-face{font-family:Xiaolai;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");unicode-range:${RANGE};}`
    })
    .catch(() => ''))
}
