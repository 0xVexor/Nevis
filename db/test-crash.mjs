// Kills a writer process mid-transaction, then checks the DB is intact and has no partial data.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import assert from 'node:assert/strict'

const path = new URL('./crash.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })

const setup = new DatabaseSync(path)
setup.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
setup.exec("INSERT INTO t(v) VALUES ('committed')")
setup.close()

const writer = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(${JSON.stringify(path)})
db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL')
db.exec('BEGIN')
for (let i = 0; i < 50000; i++) db.exec("INSERT INTO t(v) VALUES ('uncommitted')")
console.log('READY'); setInterval(() => {}, 1000)  // hold the open transaction
`
const child = spawn(process.execPath, ['-e', writer], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((res) => child.stdout.on('data', (d) => String(d).includes('READY') && res()))
child.kill('SIGKILL') // abrupt death, no cleanup (like power loss for the process)
await new Promise((res) => child.on('exit', res))

const db = new DatabaseSync(path)
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
assert.deepEqual(db.prepare('SELECT v, count(*) c FROM t GROUP BY v').all().map((r) => ({ ...r })), [{ v: 'committed', c: 1 }])
db.close()
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true })
console.log('crash test OK — uncommitted transaction rolled back, integrity ok')
