import { getSettings } from './settings'
import { IMAGE_MAX_SIDE, IMAGE_LOSSLESS, IMAGE_MIN_BYTES, IMAGE_QUALITY, fitTo, worthKeeping } from './media/plan'

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']) // GIF is handled in media/gif.ts, SVG is vector: never touched

/** Target size for an image: shrunk to the stored maximum on its longest edge, never enlarged. */
export function fitSize(w: number, h: number, max = IMAGE_MAX_SIDE): { w: number; h: number; scaled: boolean } {
  return fitTo(w, h, max)
}

/**
 * Large pictures are shrunk before they are stored, because every image is a file in the vault.
 * Quality comes first: a photo (JPEG) becomes high-quality WebP, a PNG becomes lossless WebP (every pixel and its transparency kept),
 * and the original is kept whenever the result is not clearly smaller.
 */
export async function maybeCompress(file: Blob): Promise<Blob> {
  if (!getSettings().compressImages || !TYPES.has(file.type)) return file
  try {
    const bmp = await createImageBitmap(file)
    const { w, h, scaled } = fitSize(bmp.width, bmp.height)
    if (!scaled && file.size < IMAGE_MIN_BYTES) return (bmp.close(), file)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return (bmp.close(), file)
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: file.type === 'image/png' ? IMAGE_LOSSLESS : IMAGE_QUALITY })
    return out.type === 'image/webp' && worthKeeping(out.size, file.size) ? out : file
  } catch {
    return file // an image the browser cannot decode is stored as it is
  }
}
