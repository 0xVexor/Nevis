import { getSettings } from './settings'

const MAX_SIDE = 2560 // longest edge in pixels: plenty for a screen, far smaller than a phone or camera original
const MIN_BYTES = 600 * 1024 // smaller pictures are left alone
const QUALITY = 0.85
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']) // GIF may be animated and SVG is vector: never touched

/** Target size for an image: shrunk to MAX_SIDE on its longest edge, never enlarged. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number; scaled: boolean } {
  const long = Math.max(w, h)
  if (long <= max) return { w, h, scaled: false }
  const k = max / long
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true }
}

/**
 * Large pictures are shrunk before they are stored, because every image is a file in the vault and travels through sync.
 * JPEG stays JPEG; PNG becomes WebP (keeps transparency, usually far smaller). The original is kept whenever the result is not smaller.
 */
export async function maybeCompress(file: Blob): Promise<Blob> {
  if (!getSettings().compressImages || !TYPES.has(file.type)) return file
  try {
    const bmp = await createImageBitmap(file)
    const { w, h, scaled } = fitSize(bmp.width, bmp.height)
    if (!scaled && file.size < MIN_BYTES) return (bmp.close(), file)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return (bmp.close(), file)
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const out = await canvas.convertToBlob({ type: file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', quality: QUALITY })
    return out.size < file.size * 0.9 ? out : file
  } catch {
    return file // an image the browser cannot decode is stored as it is
  }
}
