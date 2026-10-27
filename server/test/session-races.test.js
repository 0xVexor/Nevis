import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword } from '../src/auth.js'
import { setup, call, register, login, pow, newVault, commit, sha } from './helpers.js'

test('independent logins reject stale writes and logout revokes only its device', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    const b = await login(s, 'alice', 'correct horse battery')
    assert.equal(b.status, 200)
    assert.notEqual(a.token, b.body.token)
    const v = await newVault(s, a.token)
    assert.equal((await commit(s, a.token, v, [{ put: ['pages/p.json', 'first'] }])).body.results[0].ok, true)
    assert.equal((await commit(s, b.body.token, v, [{ put: ['pages/p.json', 'old base'] }])).body.results[0].error, 'conflict')
    await call(s, 'POST', '/v1/auth/logout', { token: a.token })
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 401)
    assert.equal((await call(s, 'GET', '/v1/account', { token: b.body.token })).status, 200)
  } finally { await s.close() }
})

test('a recovery key can be consumed once even by simultaneous requests', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    const proofs = await Promise.all([pow(s), pow(s)])
    const rs = await Promise.all(proofs.map((proof, i) => call(s, 'POST', '/v1/auth/recover', {
      body: { username: 'alice', recovery_key: a.recovery, new_password: `replacement-password-${i}`, ...proof },
    })))
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409])
    const accepted = rs.find(r => r.status === 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: accepted.body.token })).status, 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 401)
  } finally { await s.close() }
})

test('login cannot issue a session from a password snapshot invalidated during verification', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    const next = await hashPassword('replacement-password')
    const prepare = s.db.prepare.bind(s.db)
    let rotated = false
    // Force the credential rotation at the read/verification boundary.
    s.db.prepare = sql => {
      const stmt = prepare(sql)
      if (sql !== 'SELECT * FROM users WHERE username = ?') return stmt
      return new Proxy(stmt, { get(target, key) {
        if (key === 'get') return (...args) => {
          const row = target.get(...args)
          if (!rotated) {
            rotated = true
            prepare('UPDATE users SET pass = ? WHERE id = ?').run(next, a.userId)
            prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ?').run(s.clock.t, a.userId)
          }
          return row
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    const r = await login(s, 'alice', 'correct horse battery')
    s.db.prepare = prepare
    assert.equal(rotated, true)
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'credentials_changed')
    assert.equal(prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n, 0)
  } finally { await s.close() }
})

test('competing password changes cannot both succeed using the same old password', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    const b = await login(s, 'alice', 'correct horse battery')
    const rs = await Promise.all([a.token, b.body.token].map((token, i) => call(s, 'POST', '/v1/auth/password', {
      token, body: { old_password: 'correct horse battery', new_password: `new-password-${i}` },
    })))
    assert.equal(rs.filter(r => r.status === 200).length, 1)
    const winner = rs.findIndex(r => r.status === 200)
    assert.equal((await login(s, 'alice', `new-password-${winner}`)).status, 200)
    assert.equal((await login(s, 'alice', `new-password-${1 - winner}`)).status, 401)
  } finally { await s.close() }
})

test('legacy and malformed protocol headers cannot start writing', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    for (const version of ['1', 'invalid', '', '2broken']) {
      const r = await call(s, 'POST', '/v1/vaults', { token: a.token, headers: { 'x-noviq-api': version }, body: { id: crypto.randomUUID(), name: 'old client' } })
      assert.equal(r.status, 426)
    }
    const r = await s.app.inject({ method: 'POST', url: '/v1/vaults', headers: { authorization: `Bearer ${a.token}` }, payload: { id: crypto.randomUUID(), name: 'no protocol' } })
    assert.equal(r.statusCode, 426)
    assert.equal((await s.app.inject({ method: 'GET', url: '/v1/health' })).statusCode, 200)
  } finally { await s.close() }
})

test('revocation after authentication is checked again before a queued operation starts', async () => {
  const s = await setup()
  try {
    const a = await register(s)
    const prepare = s.db.prepare.bind(s.db)
    let revoked = false
    s.db.prepare = sql => {
      const stmt = prepare(sql)
      if (!sql.includes('WHERE d.token_hash = ?')) return stmt
      return new Proxy(stmt, { get(target, key) {
        if (key === 'get') return (...args) => {
          const row = target.get(...args)
          if (row && !revoked) {
            revoked = true
            prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(s.clock.t, a.deviceId)
          }
          return row
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    const r = await call(s, 'POST', '/v1/vaults', { token: a.token, body: { id: crypto.randomUUID(), name: 'must not create' } })
    s.db.prepare = prepare
    assert.equal(revoked, true)
    assert.equal(r.status, 401)
    assert.equal(prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 0)
  } finally { await s.close() }
})

test('a fully staged upload can finalize after storage failure by replaying the last piece', async () => {
  const s = await setup()
  try {
    const a = await register(s), v = await newVault(s, a.token)
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7), hash = sha(bytes)
    const put = s.storage.put.bind(s.storage)
    s.storage.put = async () => { throw new Error('temporary storage failure') }
    const first = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${hash}`, { token: a.token, body: bytes })
    assert.equal(first.status, 500)
    const head = await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${hash}`, { token: a.token })
    assert.equal(head.status, 404)
    assert.equal(Number(head.headers['x-received']), bytes.length)
    s.storage.put = put
    const offset = bytes.length - 1024 * 1024
    const resumed = await call(s, 'PUT', `/v1/vaults/${v}/blobs/${hash}`, { token: a.token, body: bytes.subarray(offset), headers: { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } })
    assert.equal(resumed.status, 201)
    assert.equal((await call(s, 'HEAD', `/v1/vaults/${v}/blobs/${hash}`, { token: a.token })).status, 200)
  } finally { await s.close() }
})
