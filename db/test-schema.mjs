import { DatabaseSync } from 'node:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { normalizeFa, toFtsQuery } from './normalize.mjs'

const file = new URL('./test.db', import.meta.url)
for (const s of ['', '-wal', '-shm']) rmSync(new URL(file.href + s), { force: true })

const db = new DatabaseSync(file)
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
db.exec('BEGIN')
db.exec(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'))
db.exec('PRAGMA user_version = 1')
db.exec(readFileSync(new URL('./migrations/0002_app_fields.sql', import.meta.url), 'utf8'))
db.exec('PRAGMA user_version = 2')
db.exec('COMMIT')

const now = Date.now()
const insPage = db.prepare(`INSERT INTO pages(id,parent_id,title,sort_key,plain_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
const insMap = db.prepare(`INSERT INTO fts_map(page_id) VALUES (?) RETURNING rowid`)
const insFts = db.prepare(`INSERT INTO pages_fts(rowid,title,body) VALUES (?,?,?)`)
function addPage(id, parent, title, body, sort = 'a') {
  insPage.run(id, parent, title, sort, body, now, now)
  const { rowid } = insMap.get(id)
  insFts.run(rowid, normalizeFa(title), normalizeFa(body))
}

addPage('p1', null, 'درس جاوا', 'کلاس و شیء در برنامه‌نویسی شیءگرا. ۱۲۳ مثال', 'a')
addPage('p2', 'p1', 'وراثت', 'كلاس فرزند از كلاس پدر ارث می‌برد', 'a')
addPage('p3', 'p1', 'Polymorphism', 'Overriding and overloading in Java', 'b')
addPage('p4', null, 'ریاضی ۲', 'انتگرال و مشتق', 'b')

const search = (q) =>
  db
    .prepare(
      `SELECT p.id FROM pages_fts f JOIN fts_map m ON m.rowid = f.rowid JOIN pages p ON p.id = m.page_id
       WHERE pages_fts MATCH ? AND p.deleted_at IS NULL ORDER BY rank`,
    )
    .all(toFtsQuery(q))
    .map((r) => r.id)
    .sort()

// Persian search behaviours
assert.deepEqual(search('كلاس'), ['p1', 'p2'], 'Arabic kaf matches Persian kaf')
assert.deepEqual(search('برنامه نویسی'), ['p1'], 'ZWNJ vs space')
assert.deepEqual(search('برنامه‌نویسی'), ['p1'], 'ZWNJ in query')
assert.deepEqual(search('123'), ['p1'], 'Persian digits indexed as ASCII')
assert.deepEqual(search('۱۲۳'), ['p1'], 'Persian digits in query')
assert.deepEqual(search('وراث'), ['p2'], 'prefix search')
assert.deepEqual(search('java'), ['p3'], 'English, case-insensitive')
assert.deepEqual(search('انتگرال مشتق'), ['p4'], 'multi-word AND')
assert.deepEqual(search('چیزی که نیست'), [], 'no match')

// Page tree with recursive CTE (depth + ordering)
const tree = db
  .prepare(
    `WITH RECURSIVE t(id,parent_id,title,depth,path) AS (
       SELECT id,parent_id,title,0,sort_key FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL
       UNION ALL
       SELECT c.id,c.parent_id,c.title,t.depth+1,t.path||'/'||c.sort_key FROM pages c JOIN t ON c.parent_id=t.id WHERE c.deleted_at IS NULL)
     SELECT id,depth FROM t ORDER BY path`,
  )
  .all()
  .map((r) => `${r.id}:${r.depth}`)
assert.deepEqual(tree, ['p1:0', 'p2:1', 'p3:1', 'p4:0'])

// Backlinks
db.prepare('INSERT INTO page_links VALUES (?,?)').run('p3', 'p2')
db.prepare('INSERT INTO page_links VALUES (?,?)').run('p4', 'p2')
const back = db.prepare('SELECT source_id FROM page_links WHERE target_id=? ORDER BY 1').all('p2').map((r) => r.source_id)
assert.deepEqual(back, ['p3', 'p4'])

// Soft delete hides from search; hard delete cascades
db.prepare('UPDATE pages SET deleted_at=? WHERE id=?').run(now, 'p2')
assert.deepEqual(search('وراث'), [])
db.prepare('DELETE FROM pages WHERE id=?').run('p1')
assert.equal(db.prepare('SELECT count(*) c FROM pages WHERE parent_id=?').get('p1').c, 0, 'children cascade')
assert.equal(db.prepare('SELECT count(*) c FROM fts_map WHERE page_id=?').get('p1').c, 0, 'fts_map cascade')

// 0002 fields
assert.equal(db.prepare('SELECT kind FROM pages WHERE id=?').get('p4').kind, 'page', 'existing rows default to page')
assert.throws(() => db.prepare("UPDATE pages SET kind='x' WHERE id='p4'").run(), 'kind is constrained')
db.prepare("UPDATE pages SET kind='folder', status='todo', title_dir='rtl' WHERE id='p4'").run()
db.prepare('INSERT INTO page_tags VALUES (?,?)').run('p4', 'exam')
db.prepare('INSERT INTO page_versions VALUES (?,?,?,?)').run('p4', 1, 't', '{}')
db.prepare('INSERT INTO srs VALUES (?,?,?,?,?)').run('p4:abc', 2.5, 0, 0, 0)
db.prepare('INSERT INTO kv VALUES (?,?)').run('backupCfg', '{"enabled":false}')
db.prepare('DELETE FROM pages WHERE id=?').run('p4')
assert.equal(db.prepare('SELECT count(*) c FROM page_tags').get().c, 0, 'tags cascade')
assert.equal(db.prepare('SELECT count(*) c FROM page_versions').get().c, 0, 'versions cascade')
assert.equal(db.prepare('SELECT count(*) c FROM srs').get().c, 1, 'cards outlive their page')
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)

// Integrity + WAL
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
console.log('schema OK — all assertions passed')
db.close()
for (const s of ['', '-wal', '-shm']) rmSync(new URL(file.href + s), { force: true })
