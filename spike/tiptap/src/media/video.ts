// Re-encodes a large video to H.264/AAC in an MP4, smaller on screen and at a sane bitrate. It runs in the page with WebCodecs
// (hardware accelerated where the system has it) and loads its library only when a video is added. Anything it cannot handle
// is stored as it is: a video that is not changed is better than one that is lost.
import { getSettings } from '../settings'
import { VIDEO_MAX_FPS, VIDEO_MAX_SIDE, fitTo, shouldTranscodeVideo, worthKeeping } from './plan'

export const isVideo = (type: string) => type.startsWith('video/')

export async function optimizeVideo(file: Blob, onProgress?: (fraction: number) => void): Promise<Blob> {
  if (!getSettings().compressImages || !isVideo(file.type)) return file
  try {
    const mb = await import('mediabunny')
    if (!(await mb.canEncodeVideo('avc'))) return file
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) return file
    const [seconds, stats] = await Promise.all([input.computeDuration(), track.computePacketStats(120)])
    const facts = { bytes: file.size, seconds, width: track.displayWidth, height: track.displayHeight, fps: stats.averagePacketRate }
    if (!shouldTranscodeVideo(facts)) return file
    const size = fitTo(facts.width, facts.height, VIDEO_MAX_SIDE, true)
    const target = new mb.BufferTarget()
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const conversion = await mb.Conversion.init({
      input,
      output,
      copy: false, // a copy keeps the bitrate, and the bitrate is the point
      video: { width: size.w, height: size.h, fit: 'contain', codec: 'avc', quality: mb.QUALITY_HIGH, ...(facts.fps > VIDEO_MAX_FPS + 1 ? { frameRate: VIDEO_MAX_FPS } : {}) },
      audio: { codec: 'aac', quality: mb.QUALITY_MEDIUM },
      showWarnings: false,
    })
    if (!conversion.isValid) return file
    if (onProgress) conversion.onProgress = onProgress
    await conversion.execute()
    if (!target.buffer) return file
    const out = new Blob([target.buffer], { type: 'video/mp4' })
    return worthKeeping(out.size, file.size) ? out : file
  } catch {
    return file
  }
}
