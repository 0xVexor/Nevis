import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUpdateController } from '../spike/tiptap/src/updateController.ts'

const stable = { version: '1.1.0', prerelease: false, notes: 'Changes', publishedAt: null }
const preview = { ...stable, version: '1.2.0-beta.1', prerelease: true }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(over = {}) {
  const calls = []
  let include = false
  const controller = createUpdateController({
    includePrerelease: () => include,
    check: async (flag) => { calls.push(['check', flag]); return flag ? preview : stable },
    download: async (version, progress) => { calls.push(['download', version]); progress({ downloaded: 25, total: 100 }) },
    save: async () => { calls.push(['save']) },
    install: async (version) => { calls.push(['install', version]) },
    ...over,
  })
  return { controller, calls, channel: value => { include = value; controller.channelChanged() } }
}
test('stable by default; a background check only notifies; no installation without approval', async () => {
  const { controller: c, calls } = setup()
  await c.check()
  assert.deepEqual(calls, [['check', false]])
  assert.equal(c.getSnapshot().notice, true)
  assert.equal(c.getSnapshot().dialog, false)
  await c.install()
  assert.equal(calls.length, 1)
  c.open()
  await c.download()
  assert.equal(c.getSnapshot().phase, 'ready')
  assert.deepEqual(c.getSnapshot().progress, { downloaded: 25, total: 100 })
  await c.install()
  assert.deepEqual(calls.slice(-2), [['save'], ['install', '1.1.0']])
})
test('Later suppresses repeated notices for the session; manual checks still open details', async () => {
  const { controller: c } = setup()
  await c.check(); c.dismiss(); await c.check()
  assert.equal(c.getSnapshot().notice, false)
  await c.check(true)
  assert.equal(c.getSnapshot().dialog, true)
})
test('switching off previews discards an in-flight result and checks the stable channel', async () => {
  const waiting = deferred()
  let first = true
  const flags = []
  const { controller: c, channel } = setup({ check: async (flag) => {
    flags.push(flag)
    if (first) { first = false; return waiting.promise }
    return flag ? preview : stable
  } })
  channel(true)
  channel(false)
  waiting.resolve(preview)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(flags, [true, false])
  assert.equal(c.getSnapshot().update.version, stable.version)
})
test('failed saving keeps the downloaded update and blocks installation until retry succeeds', async () => {
  let fail = true, installed = 0
  const { controller: c } = setup({ save: async () => { if (fail) throw Error('disk full') }, install: async () => { installed++ } })
  await c.check(); await c.download(); await c.install()
  assert.equal(installed, 0)
  assert.equal(c.getSnapshot().phase, 'ready')
  assert.equal(c.getSnapshot().error, 'UPDATE_SAVE_FAILED')
  fail = false
  await c.install()
  assert.equal(installed, 1)
})
test('failed or unsigned download cannot be installed; retry is possible', async () => {
  let downloads = 0, installed = 0
  const { controller: c } = setup({ download: async () => { if (++downloads === 1) throw Error('signature invalid') }, install: async () => { installed++ } })
  await c.check(); await c.download(); await c.install()
  assert.equal(c.getSnapshot().phase, 'error')
  assert.equal(installed, 0)
  await c.download()
  assert.equal(c.getSnapshot().phase, 'ready')
})
test('duplicate requests are serialized and background checks cannot replace a download', async () => {
  const waiting = deferred()
  let downloads = 0
  const { controller: c, calls } = setup({ download: async () => { downloads++; await waiting.promise } })
  await c.check()
  const run = c.download()
  await c.download(); await c.check(); c.close()
  assert.equal(downloads, 1)
  assert.equal(calls.filter(c => c[0] === 'check').length, 1)
  assert.equal(c.getSnapshot().dialog, true)
  waiting.resolve(); await run
  assert.equal(c.getSnapshot().phase, 'ready')
})
test('manual no-update and offline checks have visible status', async () => {
  const { controller: c } = setup({ check: async () => null })
  await c.check(true)
  assert.equal(c.getSnapshot().phase, 'current')
  const { controller: offline } = setup({ check: async () => { throw Error('offline') } })
  await offline.check(true)
  assert.equal(offline.getSnapshot().phase, 'error')
  assert.equal(offline.getSnapshot().notice, false)
})
