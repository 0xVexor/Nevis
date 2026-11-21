// Ported from sceneLoad.test.mjs, adapted: the scene is an inline JSON string, not an attachment Blob.
import { describe, expect, it } from 'vitest'
import { MAX_DRAWING_SCENE } from '@nevis/schema'
import { readScene, writeScene } from '../src/scene'

const restore = (d: unknown) => ({ elements: (d as { elements: unknown[] }).elements, files: (d as { files?: object }).files ?? {} })
const scene = { elements: [{ id: 'a', version: 3 }], files: {} }

describe('drawing scene', () => {
  it('a stored scene is read back', () => {
    const r = readScene(JSON.stringify(scene), restore)
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.scene.elements).toEqual(scene.elements)
  })
  it('no scene is an empty, editable canvas', () => expect(readScene('', () => { throw new Error('must not restore') })).toEqual({ status: 'empty' }))
  it('broken JSON and a failing restore are unreadable (and the caller must not save over them)', () => {
    expect(readScene('{nope', restore).status).toBe('unreadable')
    const boom = new Error('bad scene')
    const r = readScene('{}', () => { throw boom })
    expect(r.status === 'unreadable' && r.error).toBe(boom)
  })
  it('a scene over 256 KB is refused at write time, one under it is written as is', () => {
    expect(writeScene(scene)).toEqual({ ok: true, json: JSON.stringify(scene) })
    const big = writeScene({ elements: [{ blob: 'x'.repeat(MAX_DRAWING_SCENE) }] })
    expect(big.ok).toBe(false)
    expect(!big.ok && big.reason).toBe('too_large')
    const circular: Record<string, unknown> = {}; circular.self = circular
    expect(writeScene(circular)).toEqual({ ok: false, reason: 'unserializable' })
  })
})
