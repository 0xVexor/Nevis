// A drawing's scene is a JSON STRING in the node's `scene` attribute (<= 256 KB until attachments exist in M9). Reading and writing
// it never throws: every failure is an outcome, so the editor can refuse to edit and, above all, refuse to SAVE over a scene it could
// not read. Free of the Excalidraw library (injected) so it is tested in plain Node. (The old editor read the scene from an attachment
// Blob; the outcomes `empty | ok | unreadable` carry over, `missing` has no meaning for an inline string.)
import { MAX_DRAWING_SCENE } from '@nevis/schema'

export type SceneLoad<S> = { status: 'empty' } | { status: 'ok'; scene: S } | { status: 'unreadable'; error: unknown }

export function readScene<S>(json: string, restore: (data: unknown) => S): SceneLoad<S> {
  if (!json) return { status: 'empty' }
  try { return { status: 'ok', scene: restore(JSON.parse(json)) } } catch (error) { return { status: 'unreadable', error } }
}

export type SceneSave = { ok: true; json: string } | { ok: false; reason: 'too_large' | 'unserializable'; size?: number }
/** The string to store, or why it must not be (over `max`: the 256 KB an inline scene may have, or what an attachment may hold; or not serializable). */
export function writeScene(scene: unknown, max: number = MAX_DRAWING_SCENE): SceneSave {
  let json: string
  try { json = JSON.stringify(scene) } catch { return { ok: false, reason: 'unserializable' } }
  return json.length > max ? { ok: false, reason: 'too_large', size: json.length } : { ok: true, json }
}
