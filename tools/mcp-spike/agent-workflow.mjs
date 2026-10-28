import { acceptanceEndpoint, acceptanceToken } from './acceptance-auth.mjs'
/** Launch a real Codex CLI acceptance session without changing the user's client configuration. */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
const [endpoint, fixturePath, grantId, outputRoot] = process.argv.slice(2)
if (!endpoint?.startsWith('http://127.0.0.1:') || !outputRoot?.startsWith('/tmp/nevis-mcp-acceptance/')) throw new Error('Use only the disposable local acceptance environment')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const url = acceptanceEndpoint(endpoint), token = acceptanceToken(grantId)
const stamp = Date.now().toString(36)
const prompt = `You are testing the Nevis MCP feature using a disposable synthetic vault. Use only tools from the nevis MCP server. Do not use shell, browser, filesystem, other servers or subagents. The user explicitly approved read/write access to the synthetic Allowed acceptance root and excluded the private fixture. Discover the allowed note whose title is MCP acceptance فارسی Java. Search for محفوظ, inspect its outline, then read the section under heading. Read the full note to establish the exact current revision and saved structured content. Preview an edit that appends a paragraph with text AGENT_ACCEPTANCE_${stamp} using operationId agent-${stamp}. Apply the identical operation, retry that identical apply with the original expected revision to verify replayed=true, and read back the saved marker. Read its retained history. Undo that edit using operationId undo-agent-${stamp} and the saved after revision, then read again to verify the original content was restored and the marker is gone. Do not edit another document or add other changes. Report the document ID, calls performed, replay evidence, undo evidence, and any failure honestly.`
const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-C', '/tmp/nevis-mcp-acceptance', '--json', '-o', `${outputRoot}/agent-result.txt`, '-c', `mcp_servers.nevis.url=${JSON.stringify(endpoint)}`, '-c', 'mcp_servers.nevis.bearer_token_env_var="NEVIS_ACCEPTANCE_TOKEN"', prompt]
const started = performance.now()
const child = spawn('codex', args, { env: { ...process.env, NEVIS_ACCEPTANCE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
let events = '', diagnostics = ''
child.stdout.on('data', chunk => { events += chunk }); child.stderr.on('data', chunk => { diagnostics += chunk })
const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }); clearTimeout(timer)
await writeFile(`${outputRoot}/agent-events.jsonl`, events)
await writeFile(`${outputRoot}/agent-diagnostics.txt`, diagnostics)
console.log(JSON.stringify({ exitCode: code, durationMs: Math.round(performance.now() - started), outputRoot }))
process.exitCode = code ?? 1
