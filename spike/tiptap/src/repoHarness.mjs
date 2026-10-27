import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Load the repository against a storage seam without opening a browser or a real
// user vault. Keep the production repository implementation intact in the test.
const source = readFileSync(new URL('./repo.ts', import.meta.url), 'utf8')
  .replace(/^import .* from '\.\/normalize'\n/m, 'const normalizeFa = s => s\n')
  .replace(/^import .* from '\.\/db'\n/m, 'const { addVersion, allPages, deleteVersions, isTauri, listVersions, savePages, vaultStamp, storageFrozen } = storage\n')
  .replace(/^export /gm, '')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const load = new Function('storage', 'window', 'localStorage', 'navigator', `${compiled}; return Repo`)
export const page = (title = 'local', at = 100) => ({ id: 'p', parentId: null, title, favorite: false, sort: 0, content: { type: 'doc', content: [] }, updatedAt: at, deletedAt: null })

export function harness(overrides = {}) {
  let rows = [page()], stamp = 'one'
  const events = [], writes = []
  const storage = {
    storageFrozen: () => false, isTauri: true, allPages: async () => structuredClone(rows), vaultStamp: async () => stamp,
    savePages: async upserts => { writes.push(structuredClone(upserts)); rows = structuredClone(upserts); stamp += '!'; return { pages: rows } },
    addVersion: async () => {}, deleteVersions: async () => {}, listVersions: async () => [], ...overrides,
  }
  const window = { setTimeout: () => 1, dispatchEvent: e => { events.push(e); return true } }
  const Repo = load(storage, window, { getItem: () => null }, {})
  return { repo: new Repo(() => [page('seed')]), events, writes, setRows: r => { rows = r; stamp += '!' } }
}
