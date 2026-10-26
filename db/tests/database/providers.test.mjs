// Provider adapters on recorded-style fixtures (handoff §26): reference validation, retrieval, pagination, retry / refresh / revoked access,
// and the commands that record what came back. Mock fixtures prove `adapter_tested`; they never prove `connection_verified`.
import test from 'node:test'
import assert from 'node:assert/strict'

const P = '../../../spike/tiptap/src/database/'
const { googleDrive, figma, zendesk, githubPullRequest, detectProvider } = await import(P + 'providers/connected.ts')
const { githubIssues, gitlab, jira, asana, pullAll } = await import(P + 'providers/sources.ts')
const { ProviderError } = await import(P + 'providers/types.ts')
const { parseReference } = await import(P + 'providers/refs.ts')
const { refreshConnected } = await import(P + 'providers/refresh.ts')
const { GatewayError } = await import(P + 'gateway/client.ts')
const { createHarness } = await import(P + 'fixtures.ts')

/** fetch stub: routes by URL prefix, records calls. */
function stub(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const hit = routes.find((r) => String(url).includes(r.match))
    if (!hit) throw new Error('unexpected request ' + url)
    const r = typeof hit.reply === 'function' ? hit.reply(calls.length, init) : hit.reply
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} })
  }
  return { fetchImpl, calls }
}
const deps = (s, over = {}) => ({ fetchImpl: s.fetchImpl, credentials: { token: 'tok' }, now: () => 1_000, sleep: async () => {}, ...over })

test('references: only the provider\'s own hosts and shapes are accepted', () => {
  const d = deps(stub([]))
  assert.deepEqual(googleDrive(d).validateReference('https://drive.google.com/file/d/1AbCdEfGhIjKl/view?usp=sharing'), { externalId: '1AbCdEfGhIjKl', canonicalUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKl/view' })
  assert.equal(googleDrive(d).validateReference('https://docs.google.com/document/d/1AbCdEfGhIjKl/edit').externalId, '1AbCdEfGhIjKl')
  assert.throws(() => googleDrive(d).validateReference('https://evil.example.com/file/d/1AbCdEfGhIjKl'), ProviderError)
  assert.equal(figma(d).validateReference('https://www.figma.com/design/AbCdEfGhIj12/My-file?node-id=1').externalId, 'AbCdEfGhIj12')
  assert.throws(() => figma(d).validateReference('https://figma.com.evil.test/file/AbCdEfGhIj12'), ProviderError)
  assert.equal(zendesk(d).validateReference('https://acme.zendesk.com/agent/tickets/4521').externalId, 'acme:4521')
  assert.throws(() => zendesk(d).validateReference('https://zendesk.com.evil.test/agent/tickets/1'), ProviderError)
  assert.throws(() => zendesk(d).validateReference('https://acme.zendesk.com/hc/en-us'), ProviderError)
  assert.equal(githubPullRequest(d).validateReference('https://github.com/octo/repo/pull/42/files').externalId, 'octo/repo#42')
  assert.throws(() => githubPullRequest(d).validateReference('https://github.com/octo/repo/issues/42'), ProviderError)
  assert.throws(() => githubPullRequest(d).validateReference('not a url'), ProviderError)
  assert.equal(detectProvider('https://github.com/octo/repo/pull/42', d).id, 'github_pr')
  assert.equal(detectProvider('https://example.com/x', d), null)
  assert.equal(parseReference('https://www.figma.com/file/AbCdEfGhIj12').provider, 'figma')
  assert.equal(parseReference('https://www.figma.com/file/AbCdEfGhIj12', 'github_pr'), null)
})

test('retrieve: Drive, Figma, Zendesk and GitHub PR return typed fields tagged with fetchedAt and provider revision', async () => {
  const s = stub([
    { match: '/drive/v3/files/1AbCdEfGhIjKl', reply: { body: { id: '1AbCdEfGhIjKl', name: 'Spec', mimeType: 'application/pdf', modifiedTime: '2026-10-20T10:00:00Z', version: '17', webViewLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKl/view' } } },
    { match: '/v1/files/AbCdEfGhIj12', reply: { body: { name: 'Design', lastModified: '2026-10-21T00:00:00Z', version: '99', editorType: 'figma', thumbnailUrl: 'https://x/t.png' } } },
    { match: 'acme.zendesk.com/api/v2/tickets/4521.json', reply: { body: { ticket: { id: 4521, subject: 'Printer', status: 'open', priority: 'high', updated_at: '2026-10-22T00:00:00Z' } } } },
    { match: '/repos/octo/repo/pulls/42', reply: { body: { number: 42, title: 'Fix it', state: 'closed', merged: true, draft: false, user: { login: 'amy' }, updated_at: '2026-10-23T00:00:00Z', html_url: 'https://github.com/octo/repo/pull/42', head: { sha: 'abc123' } } } },
  ])
  const d = deps(s)
  const a = await googleDrive(d).retrieve({ externalId: '1AbCdEfGhIjKl' })
  assert.deepEqual([a.provider, a.fields.name, a.providerRevision, a.fetchedAt], ['gdrive', 'Spec', '17', 1000])
  assert.equal((await figma(d).retrieve({ externalId: 'AbCdEfGhIj12' })).fields.editorType, 'figma')
  const z = await zendesk(d).retrieve({ externalId: 'acme:4521' })
  assert.deepEqual([z.fields.status, z.canonicalUrl], ['open', 'https://acme.zendesk.com/agent/tickets/4521'])
  const g = await githubPullRequest(d).retrieve({ externalId: 'octo/repo#42' })
  assert.deepEqual([g.fields.state, g.providerRevision], ['merged', 'abc123'])
  assert.equal(s.calls[0].init.headers.authorization, 'Bearer tok')
  assert.equal(s.calls[3].init.headers['x-github-api-version'], '2022-11-28')
})

test('errors: 401 refreshes the credential once; revoked = unauthorized; 404/403 = not visible (never "deleted"); 429 honours Retry-After; 5xx gives up as unavailable', async () => {
  const seen = []
  let s = stub([{ match: '/pulls/1', reply: (n, init) => (init.headers.authorization === 'Bearer fresh' ? { body: { number: 1, title: 't', state: 'open', head: { sha: 's' } } } : { status: 401, body: {} }) }])
  const refresh = async () => (seen.push('refresh'), 'fresh')
  assert.equal((await githubPullRequest(deps(s, { credentials: { token: 'old', refresh } })).retrieve({ externalId: 'o/r#1' })).fields.title, 't')
  assert.deepEqual(seen, ['refresh'])
  s = stub([{ match: '/pulls/1', reply: { status: 401, body: {} } }])
  await assert.rejects(() => githubPullRequest(deps(s, { credentials: { token: 'old', refresh: async () => null } })).retrieve({ externalId: 'o/r#1' }), (e) => e.code === 'unauthorized')
  assert.equal(s.calls.length, 1)
  s = stub([{ match: '/pulls/1', reply: { status: 404, body: {} } }])
  await assert.rejects(() => githubPullRequest(deps(s)).retrieve({ externalId: 'o/r#1' }), (e) => e.code === 'not_found')
  s = stub([{ match: '/pulls/1', reply: { status: 403, body: {} } }])
  await assert.rejects(() => githubPullRequest(deps(s)).retrieve({ externalId: 'o/r#1' }), (e) => e.code === 'forbidden')
  const waits = []
  s = stub([{ match: '/pulls/1', reply: (n) => (n < 3 ? { status: 429, headers: { 'retry-after': '7' }, body: {} } : { body: { number: 1, title: 'ok', state: 'open', head: { sha: 's' } } }) }])
  assert.equal((await githubPullRequest(deps(s, { sleep: async (ms) => void waits.push(ms) })).retrieve({ externalId: 'o/r#1' })).fields.title, 'ok')
  assert.deepEqual(waits, [7000, 7000])
  s = stub([{ match: '/pulls/1', reply: { status: 503, body: {} } }])
  await assert.rejects(() => githubPullRequest(deps(s, { sleep: async () => {} })).retrieve({ externalId: 'o/r#1' }), (e) => e.code === 'unavailable')
  assert.equal(s.calls.length, 4) // bounded
})

test('pagination: GitHub Link, GitLab x-next-page, Jira nextPageToken, Asana offset; since = delta (never "complete")', async () => {
  const gh = stub([{ match: '/repos/o/r/issues', reply: (n) => ({ body: [{ id: n, number: n, title: 'I' + n, html_url: 'u' + n, updated_at: '2026-01-0' + n, state: 'open', user: { login: 'amy' }, labels: [{ name: 'bug' }] }], headers: n < 3 ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {} }) }])
  const r = await pullAll(githubIssues(deps(gh)), 'o/r')
  assert.deepEqual(r.items.map((i) => i.title), ['I1', 'I2', 'I3'])
  assert.equal(r.complete, true)
  assert.deepEqual(r.items[0].fields.labels, ['bug'])
  const delta = await pullAll(githubIssues(deps(stub([{ match: '/issues', reply: { body: [] } }]))), 'o/r', { since: '2026-01-01T00:00:00Z' })
  assert.equal(delta.complete, false)

  const gl = stub([{ match: '/projects/grp%2Fproj/merge_requests', reply: (n) => ({ body: [{ id: 10 + n, iid: n, title: 'MR' + n, web_url: 'w', updated_at: 't' + n, state: 'opened', author: { username: 'bo' }, labels: [] }], headers: n < 2 ? { 'x-next-page': '2' } : {} }) }])
  assert.deepEqual((await pullAll(gitlab(deps(gl)), 'grp%2Fproj:merge_requests')).items.map((i) => i.externalObjectId), ['11', '12'])

  const ji = stub([{ match: '/rest/api/3/search/jql', reply: (n, init) => ({ body: n === 1 ? { issues: [{ id: '1', key: 'AB-1', fields: { summary: 'S1', status: { name: 'To Do' }, updated: 'u1', labels: [] } }], nextPageToken: 'tok2' } : { issues: [{ id: '2', key: 'AB-2', fields: { summary: 'S2', status: { name: 'Done' }, updated: 'u2', labels: [] } }] } }) }])
  const jr = await pullAll(jira(deps(ji)), 'abcdef12-3456/AB')
  assert.deepEqual(jr.items.map((i) => i.fields.status), ['To Do', 'Done'])
  assert.equal(JSON.parse(ji.calls[1].init.body).nextPageToken, 'tok2')

  const as = stub([{ match: '/projects/1234567/tasks', reply: (n) => ({ body: { data: [{ gid: 'g' + n, name: 'T' + n, completed: n === 2, modified_at: 'm' + n }], next_page: n < 2 ? { offset: 'off' } : null } }) }])
  const ar = await pullAll(asana(deps(as)), '1234567')
  assert.deepEqual(ar.items.map((i) => [i.title, i.fields.completed]), [['T1', false], ['T2', true]])
  assert.ok(as.calls[1].url.includes('offset=off'))
  assert.throws(() => asana(deps(as)).validateReference('abc'), ProviderError)
  assert.throws(() => jira(deps(as)).validateReference('nope'), ProviderError)
})

// ───── commands ─────

async function importFixture() {
  const h = createHarness()
  const db = await h.one('database.create', { title: 'Issues' })
  const mk = async (name, kind, config) => (await h.one('property.create', { sourceId: db.sourceId, name, kind, config })).propertyId
  const state = await mk('State', 'select', { options: [{ name: 'open' }, { name: 'closed' }] })
  const url = await mk('Link', 'url')
  const note = await mk('My notes', 'text')
  const who = await mk('Assignee', 'people')
  const amy = await h.one('principal.upsert', { id: 'amy-id', displayName: 'Amy', kind: 'user' }).catch(() => null)
  await h.one('external.configure', { sourceId: db.sourceId, provider: 'github_issues', externalSourceId: 'o/r', fieldMap: { title: '$title', state, url }, identityMap: {}, statusMap: {} })
  return { h, db, state, url, note, who, amy }
}
const item = (id, title, rev, fields = {}) => ({ externalObjectId: id, title, url: 'https://x/' + id, revision: rev, fields: { state: 'open', url: 'https://x/' + id, ...fields } })
const apply = (h, sourceId, items, complete = false, t = 5) => h.one('external.apply', { sourceId, items, complete, fetchedAt: t }, { origin: 'import' })

test('import: identity-keyed upsert is idempotent, updates by revision, leaves local overlays alone', async () => {
  const { h, db, note, state } = await importFixture()
  let r = await apply(h, db.sourceId, [item('1', 'First', 'r1'), item('2', 'Second', 'r1')])
  assert.deepEqual([r.created, r.updated, r.unchanged], [2, 0, 0])
  r = await apply(h, db.sourceId, [item('1', 'First', 'r1'), item('2', 'Second', 'r1')])
  assert.deepEqual([r.created, r.updated, r.unchanged], [0, 0, 2]) // resync changes nothing
  assert.equal(h.state.live('property').length > 0, true)
  const rows = h.state.rows(db.sourceId)
  assert.equal(rows.length, 2)
  const first = rows.find((x) => x.page.title === 'First')
  assert.deepEqual(first.ext.external, { provider: 'github_issues', externalSourceId: 'o/r', externalObjectId: '1', revision: 'r1', fetchedAt: 5, url: 'https://x/1', tombstoned: false })
  // a person adds their own overlay on a property the provider does not own
  await h.one('row.patch', { pageId: first.page.id, cellChanges: { [note]: { kind: 'text', runs: [{ text: 'mine' }] } } })
  r = await apply(h, db.sourceId, [item('1', 'First (renamed)', 'r2', { state: 'closed' })], false, 6)
  assert.deepEqual([r.updated, r.created], [1, 0])
  const after = h.state.row(first.page.id)
  assert.equal(after.page.title, 'First (renamed)')
  assert.equal(after.ext.cells[note].value.runs[0].text, 'mine') // the overlay survived
  const closed = h.state.prop(state).config.options.find((o) => o.name === 'closed').id
  assert.equal(after.ext.cells[state].value.optionId, closed)
  assert.equal(after.ext.external.revision, 'r2')
})

test('import: provider-owned values are read-only for people, other properties stay editable', async () => {
  const { h, db, state, note } = await importFixture()
  await apply(h, db.sourceId, [item('1', 'First', 'r1')])
  const row = h.state.rows(db.sourceId)[0]
  const closed = h.state.prop(state).config.options.find((o) => o.name === 'closed').id
  await assert.rejects(() => h.one('row.patch', { pageId: row.page.id, cellChanges: { [state]: { kind: 'select', optionId: closed } } }), (e) => e.code === 'READ_ONLY')
  await assert.rejects(() => h.one('row.patch', { pageId: row.page.id, title: 'mine' }), (e) => e.code === 'READ_ONLY')
  await h.one('row.patch', { pageId: row.page.id, cellChanges: { [note]: { kind: 'text', runs: [{ text: 'ok' }] } } })
  await assert.rejects(() => h.run([{ type: 'external.apply', payload: { sourceId: db.sourceId, items: [], fetchedAt: 1 } }]), (e) => e.code === 'INVALID_COMMAND') // only the importer
})

test('import: deleted or missing items are tombstoned (kept with history), and come back when the provider restores them', async () => {
  const { h, db } = await importFixture()
  await apply(h, db.sourceId, [item('1', 'One', 'r1'), item('2', 'Two', 'r1'), item('3', 'Three', 'r1')])
  let r = await apply(h, db.sourceId, [{ ...item('2', 'Two', 'r1'), deleted: true }], false, 6)
  assert.equal(r.tombstoned, 1)
  r = await apply(h, db.sourceId, [item('1', 'One', 'r1')], true, 7) // a complete listing without 2 and 3
  assert.equal(r.tombstoned, 1) // 2 was already tombstoned; 3 is new
  const rows = h.state.rows(db.sourceId)
  assert.equal(rows.length, 3) // nothing was purged
  assert.deepEqual(rows.map((x) => x.ext.external.tombstoned).sort(), [false, true, true])
  r = await apply(h, db.sourceId, [item('3', 'Three', 'r2')], false, 8)
  assert.equal(r.restored, 1)
  assert.equal(h.state.rows(db.sourceId).filter((x) => x.ext.external.tombstoned).length, 1)
  // a partial (delta) listing never tombstones anything
  r = await apply(h, db.sourceId, [], false, 9)
  assert.equal(r.tombstoned, 0)
})

test('import: unmapped values are reported, people are never guessed from a login', async () => {
  const { h, db, who } = await importFixture()
  await h.one('external.configure', { sourceId: db.sourceId, provider: 'github_issues', externalSourceId: 'o/r', fieldMap: { title: '$title', assignee: who, state: [...h.state.props(db.sourceId)].find((p) => p.name === 'State').id }, identityMap: {}, statusMap: {} })
  const r = await apply(h, db.sourceId, [item('1', 'One', 'r1', { assignee: 'amy', state: 'weird' })])
  assert.deepEqual(r.unmapped.map((u) => u.value).sort(), ['amy', 'weird'])
  assert.equal(h.state.rows(db.sourceId).length, 1) // the row is still created; only those values are left empty
})

test('connected cells: only the property\'s provider is accepted; stored cache is tagged; a failed refresh keeps the last good cache and says why', async () => {
  const h = createHarness()
  const db = await h.one('database.create', { title: 'Links' })
  const pr = (await h.one('property.create', { sourceId: db.sourceId, name: 'PR', kind: 'connected', config: { providerId: 'github_pr', connectionId: 'work', exposedFields: ['title'] } })).propertyId
  const row = (await h.one('row.create', { sourceId: db.sourceId, title: 'Task', id: 'T1' })).pageId
  await assert.rejects(() => h.one('row.patch', { pageId: row, cellChanges: { [pr]: { kind: 'connected', value: { provider: 'figma', externalId: 'AbCdEfGhIj12', canonicalUrl: 'https://www.figma.com/file/AbCdEfGhIj12', cache: null } } } }), (e) => e.code === 'INVALID_VALUE')
  await h.one('row.patch', { pageId: row, cellChanges: { [pr]: { kind: 'connected', value: { provider: 'github_pr', externalId: 'octo/repo#42', canonicalUrl: 'https://github.com/octo/repo/pull/42', cache: null } } } })
  const svc = { state: h.state, now: () => 77, tryExec: async (cmds, over) => { try { return { ok: true, commit: await h.run(cmds, over) } } catch (e) { return { ok: false, code: e.code, message: e.message } } } }
  const good = { retrieve: async () => ({ provider: 'github_pr', externalId: 'octo/repo#42', canonicalUrl: 'https://github.com/octo/repo/pull/42', fields: { title: 'Fix it', state: 'open' }, providerRevision: 'abc', fetchedAt: 70 }) }
  assert.deepEqual(await refreshConnected(svc, good, 'work', row, pr), { ok: true, status: 'ok', message: undefined })
  let cell = h.state.row(row).ext.cells[pr].value.value
  assert.deepEqual([cell.cache.fields.title, cell.cache.providerRevision, cell.cache.fetchedAt, cell.status], ['Fix it', 'abc', 70, 'ok'])
  const revoked = { retrieve: async () => { throw new GatewayError(424, 'provider_error', 'access revoked', { providerCode: 'unauthorized' }) } }
  const out = await refreshConnected(svc, revoked, 'work', row, pr)
  assert.deepEqual([out.ok, out.status], [false, 'unauthorized'])
  cell = h.state.row(row).ext.cells[pr].value.value
  assert.equal(cell.cache.fields.title, 'Fix it') // last good value stays
  assert.equal(cell.status, 'unauthorized') // and is visibly stale
  const gone = { retrieve: async () => { throw new GatewayError(424, 'provider_error', 'nope', { providerCode: 'not_found' }) } }
  assert.equal((await refreshConnected(svc, gone, 'work', row, pr)).status, 'not_visible')
  assert.ok(h.state.row(row)) // an unreachable object never deletes the item
})
