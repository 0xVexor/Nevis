import assert from 'node:assert/strict'
import test from 'node:test'
import { VIDEO_MIN_BYTES, fitTo, frameSeconds, shouldTranscodeVideo, worthKeeping } from '../src/media/plan.ts'

test('fitTo shrinks the long edge, never enlarges, and can force even sides for H.264', () => {
  assert.deepEqual(fitTo(4000, 3000, 2000), { w: 2000, h: 1500, scaled: true })
  assert.deepEqual(fitTo(800, 600, 2000), { w: 800, h: 600, scaled: false })
  assert.deepEqual(fitTo(1081, 721, 4000, true), { w: 1080, h: 720, scaled: true }, 'odd sides are rounded down to even numbers')
  const tall = fitTo(1000, 3000, 1500, true)
  assert.ok(tall.w % 2 === 0 && tall.h % 2 === 0 && tall.h === 1500)
})

test('a video is re-encoded only when it can pay off', () => {
  const MB = 1024 * 1024
  const base = { bytes: 40 * MB, seconds: 60, width: 1920, height: 1080, fps: 30 }
  assert.equal(shouldTranscodeVideo(base), true, '40 MB in a minute is over 5 Mbps')
  assert.equal(shouldTranscodeVideo({ ...base, bytes: 20 * MB }), false, 'about 2.8 Mbps at 1080p is already modest: leave it')
  assert.equal(shouldTranscodeVideo({ ...base, bytes: VIDEO_MIN_BYTES - 1, seconds: 1 }), false, 'small files are left alone')
  assert.equal(shouldTranscodeVideo({ ...base, bytes: 20 * MB, width: 3840, height: 2160 }), true, '4K is brought down to 1080p')
  assert.equal(shouldTranscodeVideo({ ...base, bytes: 20 * MB, fps: 60 }), true, '60 fps is brought down to 30')
})

test('the converted file replaces the original only when it is clearly smaller', () => {
  assert.equal(worthKeeping(89, 100), true)
  assert.equal(worthKeeping(91, 100), false)
  assert.equal(worthKeeping(0, 100), false, 'an empty result is a failure')
})

test('frame durations come from microseconds, with a default for "as fast as possible"', () => {
  assert.equal(frameSeconds(100000), 0.1)
  assert.equal(frameSeconds(0), 0.1)
  assert.equal(frameSeconds(null), 0.1)
  assert.equal(frameSeconds(5000), 0.02, 'a zero-ish delay is clamped so playback is not a blur')
})
