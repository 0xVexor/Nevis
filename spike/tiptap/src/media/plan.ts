// Decisions about shrinking pictures, GIFs and videos. Pure numbers, so they can be tested without a browser.

export const IMAGE_MAX_SIDE = 2560 // longest edge of a stored picture: sharp on a large or high-density screen, far below a camera original
export const IMAGE_MIN_BYTES = 200 * 1024 // smaller pictures are left alone
export const IMAGE_QUALITY = 0.9 // lossy WebP for photos: visually the same as the original at this setting
export const IMAGE_LOSSLESS = 1 // PNG (screenshots, text, diagrams) is stored as lossless WebP: no pixel changes, smaller file
export const VIDEO_MAX_SIDE = 1920 // a 1080p video is not shrunk
export const VIDEO_MAX_FPS = 30
export const VIDEO_KEEP_BPS = 4_000_000 // a video already at or below this bitrate is not worth another generation of loss
export const VIDEO_MIN_BYTES = 1.5 * 1024 * 1024
export const GIF_MAX_SIDE = 1280
export const GIF_MAX_FRAMES = 900 // about 30 seconds at 30 fps: beyond that the animation is a video, and memory is the limit
export const KEEP_RATIO = 0.9 // the result must be at least 10% smaller than the original, or the original stays

export interface Fit { w: number; h: number; scaled: boolean }

/** Shrinks to `max` on the longest edge (never enlarges). `even` rounds both sides down to even numbers, which H.264 requires. */
export function fitTo(w: number, h: number, max: number, even = false): Fit {
  const long = Math.max(w, h)
  const k = long > max ? max / long : 1
  let nw = Math.max(1, Math.round(w * k))
  let nh = Math.max(1, Math.round(h * k))
  if (even) {
    nw = Math.max(2, nw - (nw % 2))
    nh = Math.max(2, nh - (nh % 2))
  }
  return { w: nw, h: nh, scaled: k < 1 || nw !== w || nh !== h }
}

export interface VideoFacts { bytes: number; seconds: number; width: number; height: number; fps: number }

/** Whether re-encoding a video can pay off: it is big, too large on screen, too fast, or at a high bitrate. */
export function shouldTranscodeVideo(v: VideoFacts): boolean {
  if (v.bytes < VIDEO_MIN_BYTES) return false
  const bps = v.seconds > 0 ? (v.bytes * 8) / v.seconds : Infinity
  return bps > VIDEO_KEEP_BPS || Math.max(v.width, v.height) > VIDEO_MAX_SIDE || v.fps > VIDEO_MAX_FPS + 1
}

/** The converted file replaces the original only when it is clearly smaller. */
export const worthKeeping = (out: number, original: number) => out > 0 && out < original * KEEP_RATIO

/** Frame duration in seconds from a decoder value in microseconds; GIF decoders report 0 or nothing for "as fast as possible". */
export const frameSeconds = (micro: number | null | undefined) => (micro && micro > 0 ? Math.max(0.02, micro / 1e6) : 0.1)
