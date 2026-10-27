// The heart of the server: vaults, revisions and the conditional commit.
//
// Every path of a vault has a `rev`: the vault's `seq` at the moment the path last changed. `seq` only grows, so
// "everything since rev N" is simply `files WHERE rev > N`, and the order of events is the order of `seq`, never a
// device clock. A write says which rev it was based on (`base_rev`); if the path moved on in the meantime it is
// refused with the current state instead of overwriting it (compare-and-swap). A delete is a tombstone with a rev of
// its own, so that other devices learn about it; absence is never a delete.

import { createHash, randomBytes } from 'node:crypto'
import { tx } from './db.js'
import { checkPath, foldCase } from './paths.js'

const HEX64 = /^[0-9a-f]{64}$/

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

// ───── vaults ─────

export const vaultRow = (db, id) => db.prepare('SELECT * FROM vaults WHERE id = ?').get(id)

/** The vault of this user, or a 404 (also for somebody else's vault: its existence is not revealed). */
export function ownedVault(db, userId, id, { deleted = false } = {}) {
  const v = typeof id === 'string' ? vaultRow(db, id) : undefined
  if (!v || v.user_id !== userId || (!deleted && v.deleted_at)) throw new HttpError(404, 'no_such_vault')
  if (v.deleting) throw new HttpError(409, 'vault_deleting')
  return v
}

export function listVaults(db, userId, trashed = false) {
  return db
    .prepare(
      `SELECT v.id, v.name, v.seq, v.created_at, v.deleted_at,
              (SELECT COUNT(*) FROM files f WHERE f.vault_id = v.id AND f.deleted = 0) AS files,
              (SELECT COALESCE(SUM(size), 0) FROM blobs b WHERE b.vault_id = v.id) AS bytes
         FROM vaults v WHERE v.user_id = ? AND ${trashed ? 'v.deleted_at IS NOT NULL' : 'v.deleted_at IS NULL'} ORDER BY v.created_at`,
    )
    .all(userId)
}

const cleanName = (name) => {
  const n = String(name ?? '').trim().slice(0, 120)
  if (!n) throw new HttpError(400, 'bad_name')
  return n
}

/** Creates the vault, or confirms it is already this user's (so a retried request is harmless). */
export function createVault(db, userId, { id, name }, cfg, now = Date.now()) {
  const vid = id == null ? crypto.randomUUID() : String(id)
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(vid)) throw new HttpError(400, 'bad_id')
  return tx(db, () => {
    const have = vaultRow(db, vid)
    if (have) {
      if (have.user_id !== userId) throw new HttpError(409, 'vault_taken')
      if (have.deleting) throw new HttpError(409, 'vault_deleting')
      if (have.deleted_at) throw new HttpError(409, 'vault_deleted')
      return { created: false, id: have.id, name: have.name, epoch: have.epoch }
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE user_id = ? AND deleted_at IS NULL').get(userId).n
    if (n >= cfg.maxVaults) throw new HttpError(403, 'too_many_vaults', { limit: cfg.maxVaults })
    const epoch = randomBytes(9).toString('base64url')
    db.prepare('INSERT INTO vaults (id, user_id, name, epoch, seq, compacted, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)').run(vid, userId, cleanName(name), epoch, now)
    return { created: true, id: vid, name: cleanName(name), epoch }
  })
}

export function renameVault(db, vault, name) {
  db.prepare('UPDATE vaults SET name = ? WHERE id = ?').run(cleanName(name), vault.id)
}

export function trashVault(db, vault, now = Date.now()) {
  db.prepare('UPDATE vaults SET deleted_at = ? WHERE id = ?').run(now, vault.id)
}

export function untrashVault(db, vault) {
  if (vaultRow(db, vault.id)?.deleting) throw new HttpError(409, 'vault_deleting')
  db.prepare('UPDATE vaults SET deleted_at = NULL WHERE id = ?').run(vault.id)
}

// ───── reading ─────

export const publicFile = (r) => ({
  path: r.path,
  rev: r.rev,
  sha256: r.sha256 ?? '',
  md5: r.md5 ?? '',
  size: r.size,
  deleted: !!r.deleted,
  by_device: r.by_device ?? '',
  server_time: r.server_time,
})

const rootCache = new Map() // vault id -> { seq, root }

/** One hash over every live (path, md5): equal on two sides means the two sides hold exactly the same files. */
export function rootHash(db, vault) {
  const hit = rootCache.get(vault.id)
  if (hit && hit.seq === vault.seq) return hit.root
  const h = createHash('sha256')
  for (const r of db.prepare('SELECT path, md5 FROM files WHERE vault_id = ? AND deleted = 0 ORDER BY path').iterate(vault.id)) h.update(`${r.path}\0${r.md5}\n`)
  const root = h.digest('hex')
  rootCache.set(vault.id, { seq: vault.seq, root })
  return root
}

export function stateOf(db, vault, now = Date.now()) {
  const v = vaultRow(db, vault.id)
  const files = db.prepare('SELECT COUNT(*) AS n FROM files WHERE vault_id = ? AND deleted = 0').get(v.id).n
  return { id: v.id, name: v.name, epoch: v.epoch, seq: v.seq, compacted: v.compacted, files, root: rootHash(db, v), server_time: now }
}

/** What changed after rev `since`, oldest first. `since` older than what was compacted away means "start over". */
export function changesSince(db, vault, since, limit = 500, now = Date.now()) {
  const v = vaultRow(db, vault.id)
  const from = Number.isInteger(since) && since > 0 ? since : 0
  const max = Math.min(Math.max(Number.isInteger(limit) ? limit : 500, 1), 1000)
  if (from < v.compacted) throw new HttpError(410, 'since_too_old', { epoch: v.epoch, compacted: v.compacted })
  const rows = db.prepare('SELECT * FROM files WHERE vault_id = ? AND rev > ? ORDER BY rev LIMIT ?').all(v.id, from, max + 1)
  const more = rows.length > max
  const page = more ? rows.slice(0, max) : rows
  return { epoch: v.epoch, head: v.seq, next: more ? page.at(-1).rev : v.seq, has_more: more, files: page.map(publicFile), server_time: now }
}

export function revisionsOf(db, vault, path, limit = 50) {
  return db.prepare('SELECT * FROM revisions WHERE vault_id = ? AND path = ? ORDER BY rev DESC LIMIT ?').all(vault.id, path, limit).map(publicFile)
}

export const revisionRow = (db, vaultId, rev) => db.prepare('SELECT * FROM revisions WHERE vault_id = ? AND rev = ?').get(vaultId, rev)

// ───── writing ─────

const meta = (r) => ({ rev: r.rev, sha256: r.sha256 ?? '', md5: r.md5 ?? '', size: r.size, deleted: !!r.deleted, server_time: r.server_time })
const conflict = (row) => ({ ok: false, error: 'conflict', current: row ? meta(row) : null })
const refuse = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) })

const UPSERT_FILE = `INSERT INTO files (vault_id, path, path_ci, rev, sha256, md5, size, deleted, by_device, server_time)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (vault_id, path) DO UPDATE SET rev = excluded.rev, sha256 = excluded.sha256, md5 = excluded.md5, size = excluded.size,
    deleted = excluded.deleted, by_device = excluded.by_device, server_time = excluded.server_time`

const INSERT_REVISION = `INSERT INTO revisions (vault_id, rev, path, sha256, md5, size, deleted, by_device, server_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

function applyOp(db, vault, device, op, state, now, allowDeletes) {
  if (!op || (op.op !== 'put' && op.op !== 'delete')) return refuse('bad_op')
  const bad = checkPath(op.path)
  if (bad) return refuse('bad_path', bad)
  const base = Number.isInteger(op.base_rev) && op.base_rev >= 0 ? op.base_rev : 0
  const row = db.prepare('SELECT * FROM files WHERE vault_id = ? AND path = ?').get(vault.id, op.path)

  if (op.op === 'delete') {
    if (!row || row.deleted) return { ok: true, noop: true, rev: row?.rev ?? 0, deleted: true }
    if (base !== row.rev) return conflict(row)
    if (!allowDeletes) return refuse('bulk_delete')
    const rev = ++state.seq
    db.prepare(UPSERT_FILE).run(vault.id, op.path, foldCase(op.path), rev, null, null, 0, 1, device, now)
    db.prepare(INSERT_REVISION).run(vault.id, rev, op.path, null, null, 0, 1, device, now)
    return { ok: true, rev, deleted: true, server_time: now }
  }

  if (!HEX64.test(String(op.sha256 ?? ''))) return refuse('bad_sha')
  const blob = db.prepare('SELECT md5, size, deleting FROM blobs WHERE vault_id = ? AND sha256 = ?').get(vault.id, op.sha256)
  if (!blob) return refuse('blob_missing')
  if (blob.deleting) return refuse('blob_deleting')
  const clash = db.prepare('SELECT path FROM files WHERE vault_id = ? AND path_ci = ? AND path <> ? AND deleted = 0').get(vault.id, foldCase(op.path), op.path)
  if (clash) return refuse('path_case_clash', clash.path)

  if (row && !row.deleted) {
    if (row.sha256 === op.sha256) return { ok: true, noop: true, ...meta(row) } // the same content is already there
    if (base !== row.rev) return conflict(row)
  } else if (row) {
    if (base !== 0 && base !== row.rev) return conflict(row) // deleted: a re-creation knows no rev, or knows the tombstone's
  } else if (base !== 0) {
    return conflict(null)
  }
  const rev = ++state.seq
  db.prepare(UPSERT_FILE).run(vault.id, op.path, foldCase(op.path), rev, op.sha256, blob.md5, blob.size, 0, device, now)
  db.prepare(INSERT_REVISION).run(vault.id, rev, op.path, op.sha256, blob.md5, blob.size, 0, device, now)
  return { ok: true, rev, sha256: op.sha256, md5: blob.md5, size: blob.size, deleted: false, server_time: now }
}

class Rollback extends Error {
  constructor(results) {
    super('rollback')
    this.results = results
  }
}

/**
 * Applies a batch of writes, each against its `base_rev`. Returns `{ results, seq, changed }`; `results[i]` is
 * `{ ok: true, rev, ... }` or `{ ok: false, error: 'conflict', current }`. With `atomic` either every op is applied or none.
 * The same `op_id` always answers the same way (`replay: true`), so a client that lost the answer can simply ask again.
 */
export function commit(db, vault, deviceId, body, cfg, now = Date.now()) {
  if (vaultRow(db, vault.id)?.deleting) throw new HttpError(409, 'vault_deleting')
  const opId = String(body?.op_id ?? '')
  if (opId.length < 8 || opId.length > 80) throw new HttpError(400, 'bad_op_id')
  const ops = body?.ops
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 200) throw new HttpError(400, 'bad_ops')

  try {
    return tx(db, () => {
      const prior = db.prepare('SELECT result FROM ops WHERE vault_id = ? AND op_id = ?').get(vault.id, opId)
      if (prior) return { ...JSON.parse(prior.result), replay: true, changed: false }

      const state = { seq: vaultRow(db, vault.id).seq }
      const start = state.seq
      // a mass deletion is the most expensive kind of mistake: it needs the client to say it means it
      const live = db.prepare('SELECT COUNT(*) AS n FROM files WHERE vault_id = ? AND deleted = 0').get(vault.id).n
      const deletes = ops.filter((o) => o?.op === 'delete').length
      const window = db.prepare('SELECT * FROM deletion_windows WHERE vault_id = ? AND device_id = ?').get(vault.id, deviceId)
      const recent = window && now - window.started_at < 60000
      const initial = recent ? window.initial_live : live
      const previous = recent ? window.deleted : 0
      const allowDeletes = previous + deletes <= Math.max(5, Math.floor(initial * 0.2)) || body.confirm_bulk === true

      const results = ops.map((op) => applyOp(db, vault, deviceId, op, state, now, allowDeletes))
      if (body.atomic === true && results.some((r) => !r.ok)) throw new Rollback(results.map((r) => (r.ok ? { ok: false, error: 'not_applied' } : r)))

      const removed = results.filter(r => r.ok && r.deleted && !r.noop).length
      if (removed) db.prepare(`INSERT INTO deletion_windows (vault_id, device_id, started_at, initial_live, deleted) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vault_id, device_id) DO UPDATE SET started_at = excluded.started_at, initial_live = excluded.initial_live, deleted = excluded.deleted`)
        .run(vault.id, deviceId, recent ? window.started_at : now, initial, body.confirm_bulk === true ? 0 : previous + removed)
      if (state.seq !== start) db.prepare('UPDATE vaults SET seq = ? WHERE id = ?').run(state.seq, vault.id)
      const out = { results, seq: state.seq, server_time: now }
      db.prepare('INSERT INTO ops (vault_id, op_id, result, created_at) VALUES (?, ?, ?, ?)').run(vault.id, opId, JSON.stringify(out), now)
      return { ...out, changed: state.seq !== start }
    })
  } catch (e) {
    if (e instanceof Rollback) return { results: e.results, seq: vaultRow(db, vault.id).seq, server_time: now, changed: false }
    throw e
  }
}

/** Puts an earlier revision of a path (or the content before its deletion) back as a new revision. */
export function restoreRevision(db, vault, deviceId, { path, rev }, now = Date.now()) {
  const old = revisionRow(db, vault.id, rev)
  if (!old || old.path !== path || old.deleted) throw new HttpError(404, 'no_such_revision')
  const have = db.prepare('SELECT 1 FROM blobs WHERE vault_id = ? AND sha256 = ? AND deleting = 0').get(vault.id, old.sha256)
  if (!have) throw new HttpError(410, 'content_expired')
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM files WHERE vault_id = ? AND path = ?').get(vault.id, path)
    const state = { seq: vaultRow(db, vault.id).seq }
    const res = applyOp(db, vault, deviceId, { op: 'put', path, sha256: old.sha256, base_rev: row ? row.rev : 0 }, state, now, true)
    if (res.ok && !res.noop) db.prepare('UPDATE vaults SET seq = ? WHERE id = ?').run(state.seq, vault.id)
    return { ...res, seq: state.seq, changed: res.ok && !res.noop }
  })
}

/** A complete live snapshot, with a fixed generation and head across pages.
 * A changing server restarts the snapshot instead of combining two generations.
 */
export function snapshotPage(db, vault, { after = '', epoch, head, limit = 500 } = {}, now = Date.now()) {
  const v = vaultRow(db, vault.id)
  if ((epoch !== undefined && epoch !== v.epoch) || (head !== undefined && head !== v.seq)) {
    throw new HttpError(409, 'snapshot_changed')
  }
  if (after && (epoch === undefined || head === undefined)) throw new HttpError(400, 'bad_snapshot_cursor')
  const max = Math.min(Math.max(Number.isInteger(limit) ? limit : 500, 1), 1000)
  const rows = db.prepare('SELECT * FROM files WHERE vault_id = ? AND deleted = 0 AND path > ? ORDER BY path LIMIT ?').all(v.id, after, max + 1)
  const more = rows.length > max
  const page = rows.slice(0, max)
  return { epoch: v.epoch, head: v.seq, root: rootHash(db, v), files: page.map(publicFile),
    has_more: more, after: more ? page.at(-1).path : '', server_time: now }
}
