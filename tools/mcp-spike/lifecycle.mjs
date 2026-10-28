/** Keep old credentials only in memory while a human/desktop driver restarts the isolated app. */
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { acceptanceEndpoint, acceptanceToken } from './acceptance-auth.mjs'
const [endpoint, fixturePath, grantId, directory, mode] = process.argv.slice(2)
assert.ok(directory && resolve(directory).startsWith('/tmp/nevis-mcp-acceptance/'))
assert.ok(mode === undefined || mode === '--resume')
const oldUrl = acceptanceEndpoint(endpoint), fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.ok(resolve(fixture.vaultPath).startsWith('/tmp/nevis-mcp-acceptance/'))
assert.match(fixture.documentId, /^[a-f0-9-]{36}$/i)
const pageFile = `${fixture.vaultPath}/pages/${fixture.documentId}.json`
const stateFile = `${directory}/restart-state.json`
let state
const connect = async (url, token) => { const client = new Client({ name: 'nevis-restart-acceptance', version: '1' }); await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client }
const call = async (client, name, args) => { const out = (await client.callTool({ name, arguments: args })).structuredContent; assert.equal(out?.ok, true, JSON.stringify(out)); return out.result }
const read = client => call(client, 'read_document', { documentId: fixture.documentId, target: { kind: 'full' }, format: 'both' })
if (mode === '--resume') {
  state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(state.grantId, grantId)
  assert.equal(state.oldEndpointClosed, true)
  assert.equal(state.oldTokenRejected, true)
  const next = JSON.parse(await readFile(`${directory}/reconnected.json`, 'utf8'))
  assert.equal(next.grantId, grantId)
  state.newEndpoint = acceptanceEndpoint(next.endpoint).href
} else {
  await unlink(`${directory}/reconnected.json`).catch(error => { if (error.code !== 'ENOENT') throw error })
  const oldToken = acceptanceToken(grantId, 300000), stamp = Date.now().toString(36), client = await connect(oldUrl, oldToken)
  const originalPage = JSON.parse(await readFile(pageFile, 'utf8')), original = await read(client)
  const request = { documentId: fixture.documentId, operationId: `restart-${stamp}`, expectedRevision: original.revision, patch: { title: 'Restart checkpoint synthetic fixture' } }
  const saved = await call(client, 'update_document_metadata', request)
  await client.close()
  state = { grantId, stamp, request, receipt: saved.receipt, originalPage }
  await writeFile(`${directory}/restart-ready.json`, JSON.stringify({ operationId: request.operationId, grantId, originalTitle: originalPage.title }, null, 2))
  console.log(JSON.stringify({ stage: 'saved-before-restart', directory }))
  let next
  for (let tries = 0; tries < 600; tries++) {
    try { next = JSON.parse(await readFile(`${directory}/reconnected.json`, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await pause(500)
  }
  assert.ok(next, 'Timed out waiting for the isolated app restart and reconnection')
  assert.equal(next.grantId, grantId, 'Durable grant identity must survive restart')
  const newUrl = acceptanceEndpoint(next.endpoint)
  let oldEndpointClosed = false
  try { await fetch(oldUrl, { headers: { Authorization: `Bearer ${oldToken}` }, signal: AbortSignal.timeout(1500) }) } catch { oldEndpointClosed = true }
  assert.ok(oldEndpointClosed)
  assert.equal((await fetch(newUrl, { method: 'POST', headers: { Authorization: `Bearer ${oldToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 401, 'Old token must fail on the new endpoint')
  state = { ...state, newEndpoint: next.endpoint, oldEndpointClosed, oldTokenRejected: true }
  // Persist no credentials. A Keychain prompt can time out without losing restart evidence.
  await writeFile(stateFile, JSON.stringify(state))
}
const { request, stamp, receipt, originalPage } = state
const newUrl = acceptanceEndpoint(state.newEndpoint)
const newToken = acceptanceToken(grantId, 300000)
const restarted = await connect(newUrl, newToken)
try {
  const replay = await call(restarted, 'update_document_metadata', request)
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, receipt)
  const history = await call(restarted, 'get_document_history', { documentId: fixture.documentId }); assert.ok(history.versions.some(v => v.operationId === request.operationId))
  const undone = await call(restarted, 'undo_document_edit', { documentId: fixture.documentId, operationId: `undo-restart-${stamp}`, undoOperationId: request.operationId, expectedRevision: replay.revision })
  assert.equal(undone.metadata.title, originalPage.title)
  await read(restarted)
  const restored = JSON.parse(await readFile(pageFile, 'utf8'))
  assert.deepEqual(restored.content, originalPage.content)
  assert.equal(restored.title, originalPage.title)
  const report = { completed: true, originalReceiptAfterRestart: true, retainedHistoryAfterRestart: true, undoRestoredOriginal: true, stableGrantIdentity: true, rotatedToken: true, oldTokenRejected: true, oldEndpointClosed: state.oldEndpointClosed }
  await writeFile(`${directory}/lifecycle-report.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} finally { await restarted.close() }
