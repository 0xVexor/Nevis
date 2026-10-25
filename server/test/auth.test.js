import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { call, login, pow, register, setup } from './helpers.js'

describe('accounts', () => {
  let s
  beforeEach(async () => (s = await setup()))
  afterEach(() => s.close())

  it('registers with a username and a password, and shows a recovery key once', async () => {
    const a = await register(s)
    assert.match(a.token, /^nvq_/)
    assert.match(a.recovery, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/)
    const me = await call(s, 'GET', '/v1/account', { token: a.token })
    assert.equal(me.status, 200)
    assert.equal(me.body.user.username, 'alice')
    assert.equal(me.body.devices.length, 1)
    assert.equal(me.body.devices[0].current, true)
  })

  it('refuses a taken user name (any letter case), a weak password and a missing proof of work', async () => {
    await register(s, 'alice')
    const again = await call(s, 'POST', '/v1/auth/register', { body: { username: 'ALICE', password: 'another password', ...(await pow(s)) } })
    assert.equal(again.status, 409)
    assert.equal(again.body.error, 'username_taken')
    const weak = await call(s, 'POST', '/v1/auth/register', { body: { username: 'bob', password: 'short', ...(await pow(s)) } })
    assert.equal(weak.body.error, 'weak_password')
    const bad = await call(s, 'POST', '/v1/auth/register', { body: { username: 'bob', password: 'long enough pw' } })
    assert.equal(bad.status, 400)
    const odd = await call(s, 'POST', '/v1/auth/register', { body: { username: 'a b', password: 'long enough pw', ...(await pow(s)) } })
    assert.equal(odd.body.error, 'bad_username')
  })

  it('does not accept the same proof of work twice', async () => {
    const work = await pow(s)
    const first = await call(s, 'POST', '/v1/auth/register', { body: { username: 'one', password: 'long enough pw', ...work } })
    assert.equal(first.status, 201)
    const second = await call(s, 'POST', '/v1/auth/register', { body: { username: 'two', password: 'long enough pw', ...work } })
    assert.equal(second.status, 400)
  })

  it('needs an invite code in invite mode, and a code can be limited to a number of accounts', async () => {
    await s.close()
    s = await setup({ registration: 'invite', inviteCodes: { golden: 1, forever: Infinity } })
    const no = await call(s, 'POST', '/v1/auth/register', { body: { username: 'bob', password: 'long enough pw', invite: 'nope', ...(await pow(s)) } })
    assert.equal(no.body.error, 'bad_invite')
    const ok = await call(s, 'POST', '/v1/auth/register', { body: { username: 'bob', password: 'long enough pw', invite: 'golden', ...(await pow(s)) } })
    assert.equal(ok.status, 201)
    const used = await call(s, 'POST', '/v1/auth/register', { body: { username: 'carl', password: 'long enough pw', invite: 'golden', ...(await pow(s)) } })
    assert.equal(used.body.error, 'invite_used')
    const more = await call(s, 'POST', '/v1/auth/register', { body: { username: 'dora', password: 'long enough pw', invite: 'forever', ...(await pow(s)) } })
    assert.equal(more.status, 201)
    const proto = await call(s, 'POST', '/v1/auth/register', { body: { username: 'eve', password: 'long enough pw', invite: 'constructor', ...(await pow(s)) } })
    assert.equal(proto.body.error, 'bad_invite')
  })

  it('is closed when registration is closed', async () => {
    await s.close()
    s = await setup({ registration: 'closed' })
    const r = await call(s, 'POST', '/v1/auth/register', { body: { username: 'bob', password: 'long enough pw', ...(await pow(s)) } })
    assert.equal(r.status, 403)
  })

  it('logs in, and answers an unknown user like a wrong password', async () => {
    await register(s, 'alice', 'my secret phrase')
    const ok = await login(s, 'Alice', 'my secret phrase')
    assert.equal(ok.status, 200)
    const wrong = await login(s, 'alice', 'not it')
    const none = await login(s, 'nobody', 'not it')
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong.body, none.body)
  })

  it('locks a user name after ten wrong passwords, even for the right one', async () => {
    await register(s, 'alice', 'my secret phrase')
    for (let i = 0; i < 10; i++) assert.equal((await login(s, 'alice', 'wrong')).status, 401)
    const locked = await login(s, 'alice', 'my secret phrase')
    assert.equal(locked.status, 429)
    assert.ok(Number(locked.headers['retry-after']) > 0)
  })

  it('needs a token, and a revoked device is out at once', async () => {
    const a = await register(s)
    assert.equal((await call(s, 'GET', '/v1/account')).status, 401)
    assert.equal((await call(s, 'GET', '/v1/account', { token: 'nvq_' + 'x'.repeat(30) })).status, 401)
    assert.equal((await call(s, 'POST', '/v1/auth/logout', { token: a.token })).status, 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 401)
  })

  it('lists and revokes devices', async () => {
    const a = await register(s, 'alice', 'my secret phrase')
    const phone = (await login(s, 'alice', 'my secret phrase', 'phone')).body
    const list = await call(s, 'GET', '/v1/account', { token: a.token })
    assert.deepEqual(list.body.devices.map((d) => d.name).sort(), ['laptop', 'phone'])
    assert.equal((await call(s, 'DELETE', `/v1/devices/${phone.device.id}`, { token: a.token })).status, 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: phone.token })).status, 401)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 200)
    assert.equal((await call(s, 'DELETE', `/v1/devices/${phone.device.id}`, { token: a.token })).status, 404)
  })

  it('changing the password logs the other devices out', async () => {
    const a = await register(s, 'alice', 'my secret phrase')
    const phone = (await login(s, 'alice', 'my secret phrase')).body
    const bad = await call(s, 'POST', '/v1/auth/password', { token: a.token, body: { old_password: 'wrong', new_password: 'a brand new phrase' } })
    assert.equal(bad.status, 401)
    const ok = await call(s, 'POST', '/v1/auth/password', { token: a.token, body: { old_password: 'my secret phrase', new_password: 'a brand new phrase' } })
    assert.equal(ok.status, 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: phone.token })).status, 401)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 200)
    assert.equal((await login(s, 'alice', 'my secret phrase')).status, 401)
    assert.equal((await login(s, 'alice', 'a brand new phrase')).status, 200)
  })

  it('recovers an account with the recovery key, which then changes', async () => {
    const a = await register(s, 'alice', 'my secret phrase')
    const r = await call(s, 'POST', '/v1/auth/recover', { body: { username: 'alice', recovery_key: a.recovery.toLowerCase().replaceAll('-', ' '), new_password: 'after recovery pw', ...(await pow(s)) } })
    assert.equal(r.status, 200)
    assert.notEqual(r.body.recovery_key, a.recovery)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 401) // the old device is out
    assert.equal((await call(s, 'GET', '/v1/account', { token: r.body.token })).status, 200)
    assert.equal((await login(s, 'alice', 'after recovery pw')).status, 200)
    const again = await call(s, 'POST', '/v1/auth/recover', { body: { username: 'alice', recovery_key: a.recovery, new_password: 'yet another pw', ...(await pow(s)) } })
    assert.equal(again.status, 401)
  })

  it('wrong recovery keys are counted like wrong passwords', async () => {
    await register(s, 'alice')
    for (let i = 0; i < 10; i++) {
      const r = await call(s, 'POST', '/v1/auth/recover', { body: { username: 'alice', recovery_key: 'AAAAA-AAAAA-AAAAA-AAAAA', new_password: 'whatever pw 1', ...(await pow(s)) } })
      assert.equal(r.status, 401)
    }
    const r = await call(s, 'POST', '/v1/auth/recover', { body: { username: 'alice', recovery_key: 'AAAAA-AAAAA-AAAAA-AAAAA', new_password: 'whatever pw 1', ...(await pow(s)) } })
    assert.equal(r.status, 429)
  })

  it('a deleted account can be brought back by logging in during the grace period', async () => {
    const a = await register(s, 'alice', 'my secret phrase')
    const del = await call(s, 'DELETE', '/v1/account', { token: a.token, body: { password: 'my secret phrase' } })
    assert.equal(del.status, 200)
    assert.equal((await call(s, 'GET', '/v1/account', { token: a.token })).status, 401)
    const back = await login(s, 'alice', 'my secret phrase')
    assert.equal(back.status, 200)
    assert.equal(back.body.restored, true)
  })

  it('refuses a client that is too old', async () => {
    const r = await call(s, 'GET', '/v1/health', { headers: { 'x-noviq-api': '0' } })
    assert.equal(r.status, 426)
    assert.equal((await call(s, 'GET', '/v1/health')).body.ok, true)
  })
})
