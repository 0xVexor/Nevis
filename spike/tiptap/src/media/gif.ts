// An animated GIF is the least efficient way to store motion: a short looping video is usually 90% smaller or more. The GIF is
// decoded frame by frame (ImageDecoder), drawn at a sensible size and encoded to H.264 in an MP4. The page then plays it as a
// muted, looping picture. A GIF that is single-frame, transparent, too long, or not clearly smaller as video stays a GIF.
import { getSettings } from '../settings'
import { GIF_MAX_FRAMES, GIF_MAX_SIDE, fitTo, frameSeconds, worthKeeping } from './plan'

export const isGif = (type: string) => type === 'image/gif'

export async function gifToVideo(file: Blob): Promise<Blob | null> {
  if (!getSettings().compressImages || !isGif(file.type) || typeof ImageDecoder === 'undefined') return null
  let decoder: ImageDecoder | undefined
  try {
    const mb = await import('mediabunny')
    if (!(await mb.canEncodeVideo('avc'))) return null
    decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' })
    await decoder.tracks.ready
    const frames = decoder.tracks.selectedTrack?.frameCount ?? 0
    if (frames < 2 || frames > GIF_MAX_FRAMES) return null
    const first = await decoder.decode({ frameIndex: 0 })
    const size = fitTo(first.image.displayWidth, first.image.displayHeight, GIF_MAX_SIDE, true)
    const canvas = new OffscreenCanvas(size.w, size.h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return (first.image.close(), null)
    ctx.drawImage(first.image, 0, 0, size.w, size.h)
    first.image.close()
    // transparency has no place in H.264: such a GIF stays a GIF
    const px = ctx.getImageData(0, 0, size.w, size.h).data
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return null
    const target = new mb.BufferTarget()
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const source = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH })
    output.addVideoTrack(source, { frameRate: 30 })
    await output.start()
    let t = 0
    for (let i = 0; i < frames; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      ctx.clearRect(0, 0, size.w, size.h)
      ctx.drawImage(image, 0, 0, size.w, size.h)
      const d = frameSeconds(image.duration)
      image.close()
      await source.add(t, d)
      t += d
    }
    await output.finalize()
    if (!target.buffer) return null
    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    return worthKeeping(blob.size, file.size) ? blob : null
  } catch {
    return null
  } finally {
    decoder?.close()
  }
}
