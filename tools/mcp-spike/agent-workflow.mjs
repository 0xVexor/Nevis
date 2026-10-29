import { acceptanceEndpoint, acceptanceToken } from './acceptance-auth.mjs'
/** Launch a real Codex CLI acceptance session without changing the user's client configuration. */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
const [endpoint, fixturePath, grantId, outputRoot] = process.argv.slice(2)
if (!endpoint?.startsWith('http://127.0.0.1:') || !outputRoot?.startsWith('/tmp/nevis-mcp-acceptance/')) throw new Error('Use only the disposable local acceptance environment')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const url = acceptanceEndpoint(endpoint), token = acceptanceToken(grantId, endpoint)
if (!resolve(outputRoot).startsWith('/tmp/nevis-mcp-acceptance/') || !resolve(fixture.vaultPath).startsWith('/tmp/nevis-mcp-acceptance/')) throw new Error('Fixture and reports must remain disposable')
const pageFile = id => join(fixture.vaultPath, 'pages', `${id}.json`)
const originalPage = JSON.parse(await readFile(pageFile(fixture.documentId), 'utf8'))
const protectedFiles = await Promise.all([fixture.rootId, fixture.excludedId].map(id => readFile(pageFile(id), 'utf8')))
const stamp = Date.now().toString(36)
const prompt = `You are testing the Nevis MCP feature using a disposable synthetic vault. Use only tools from the nevis MCP server. Do not use shell, browser, filesystem, other servers or subagents. The user explicitly approved read/write access to the synthetic Allowed acceptance root and excluded the private fixture. Discover the allowed note whose title is MCP acceptance فارسی Java. Search for محفوظ, inspect its outline, then read the section under heading. Read the full note to establish the exact current revision and saved structured content. Preview an edit that appends a paragraph with text AGENT_ACCEPTANCE_${stamp} using operationId agent-${stamp}. Apply the identical operation, retry that identical apply with the original expected revision to verify replayed=true, and read back the saved marker. Read its retained history. Undo that edit using operationId undo-agent-${stamp} and the saved after revision, then read again to verify the original content was restored and the marker is gone. Use format both for the initial/final full reads. Optional budgets are at most maxChars=16000 and maxBlocks=100. The canonical append operation shape is {kind:"insert_blocks",at:{position:"end",parent:null},blocks:[{temporaryId:"new",node:{type:"paragraph",content:[{type:"text",text:"MARKER"}]}}]}; substitute the required marker. Do not edit another document or add other changes. Report the document ID, calls performed, replay evidence, undo evidence, and any failure honestly.`
const approvals = ['edit_document', 'create_document', 'update_document_metadata', 'undo_document_edit'].flatMap(tool => ['-c', `mcp_servers.nevis.tools.${tool}.approval_mode="approve"`])
const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-C', '/tmp/nevis-mcp-acceptance', '--json', '-o', `${outputRoot}/agent-result.txt`, '-c', `mcp_servers.nevis.url=${JSON.stringify(url.href)}`, '-c', 'mcp_servers.nevis.bearer_token_env_var="NEVIS_ACCEPTANCE_TOKEN"', ...approvals, prompt]
const started = performance.now()
const child = spawn('codex', args, { env: { ...process.env, NEVIS_ACCEPTANCE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
let events = '', diagnostics = ''
child.stdout.on('data', chunk => { events += chunk }); child.stderr.on('data', chunk => { diagnostics += chunk })
const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }); clearTimeout(timer)
await writeFile(`${outputRoot}/agent-events.jsonl`, events)
await writeFile(`${outputRoot}/agent-diagnostics.txt`, diagnostics)
const eventsParsed = events.split('\n').filter(Boolean).map(line => JSON.parse(line))
const calls = eventsParsed.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map(event => event.item)
const value = call => call.result?.structured_content ?? call.result?.structuredContent
const success = call => call.status === 'completed' && value(call)?.ok === true
const previews = calls.filter(call => call.tool === 'edit_document' && call.arguments?.mode === 'preview' && success(call))
const applies = calls.filter(call => call.tool === 'edit_document' && call.arguments?.mode === 'apply' && success(call))
const undo = calls.find(call => call.tool === 'undo_document_edit' && success(call))
const reads = calls.filter(call => call.tool === 'read_document' && call.arguments?.target?.kind === 'full' && success(call))
const structured = call => {
  const result = value(call)?.result
  return result?.truncated === false && result.chunks?.every(chunk => Array.isArray(chunk.structured))
    ? result.chunks.flatMap(chunk => chunk.structured) : null
}
const sameTarget = calls.every(call => call.server === 'nevis' && (!['edit_document', 'undo_document_edit', 'update_document_metadata'].includes(call.tool) || call.arguments?.documentId === fixture.documentId))
const replayed = applies.some(call => value(call)?.result?.saved?.replayed === true)
const restored = !!undo && reads.length >= 2 && structured(reads[0]) !== null && isDeepStrictEqual(structured(reads[0]), structured(reads.at(-1))) && !JSON.stringify(value(reads.at(-1))).includes(`AGENT_ACCEPTANCE_${stamp}`)
const finalPage = JSON.parse(await readFile(pageFile(fixture.documentId), 'utf8'))
const diskRestored = isDeepStrictEqual(originalPage.content, finalPage.content) && originalPage.title === finalPage.title
const protectedUnchanged = isDeepStrictEqual(protectedFiles, await Promise.all([fixture.rootId, fixture.excludedId].map(id => readFile(pageFile(id), 'utf8'))))
const originalApply = applies.some(call => value(call)?.result?.saved?.replayed === false)
const report = { client: 'Codex CLI', exitCode: code, completed: code === 0 && previews.length > 0 && applies.length >= 2 && replayed && originalApply && restored && sameTarget && diskRestored && protectedUnchanged,
  durationMs: Math.round(performance.now() - started), toolCalls: calls.length, failedCalls: calls.filter(call => !success(call)).length,
  returnedBytes: calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.result ?? {})), 0),
  evidence: { preview: previews.length > 0, originalApply, replayed, undo: !!undo, restored, sameTarget, diskRestored, protectedUnchanged } }
await writeFile(`${outputRoot}/agent-report.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
process.exitCode = report.completed ? 0 : 1
