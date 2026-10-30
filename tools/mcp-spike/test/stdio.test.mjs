import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const here = fileURLToPath(new URL('../', import.meta.url))
const launches = [
  { name: 'TypeScript source', command: process.execPath, args: [here + 'server.ts'] },
  { name: 'bundled JavaScript', command: process.execPath, args: [here + 'dist/server.cjs'] },
]
if (process.env.NEVIS_MCP_EXECUTABLE) launches.push({ name: 'standalone executable', command: process.env.NEVIS_MCP_EXECUTABLE, args: [], env: { PATH: '' }, cwd: process.env.NEVIS_MCP_EMPTY_DIR })

for (const launch of launches) {
  test(`${launch.name}: initialize, discover, call, validate and close`, { timeout: 15000 }, async (t) => {
    const client = new Client({ name: 'nevis-spike-check', version: '0.1.0' })
    const transport = new StdioClientTransport({ cwd: here, ...launch, stderr: 'pipe' })
    let diagnostics = ''
    transport.stderr?.on('data', (data) => { diagnostics += data })
    t.after(() => client.close())
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name), ['project_sample'])
    assert.equal(tools[0].annotations.readOnlyHint, true)
    const result = await client.callTool({ name: 'project_sample', arguments: { text: 'كلاس ۱۲۳ Java' } })
    assert.deepEqual(result.structuredContent, {
      original: 'كلاس ۱۲۳ Java', normalized: 'کلاس 123 java', words: ['کلاس', '123', 'java'], scope: 'sample-only',
    })
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
    const invalid = await client.callTool({ name: 'project_sample', arguments: { text: 'x'.repeat(2049) } })
    assert.equal(invalid.isError, true)
    const wrongType = await client.callTool({ name: 'project_sample', arguments: { text: 123 } })
    assert.equal(wrongType.isError, true)
    const pid = transport.pid
    assert.ok(pid)
    await client.close()
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.equal(diagnostics, '', 'no startup errors or protocol noise')
  })
}

test('EOF exits the source server without a desktop connection', { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [here + 'server.ts'], { cwd: here, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => { stdout += data })
  child.stderr.on('data', (data) => { stderr += data })
  const exited = once(child, 'exit')
  child.stdin.end()
  const [code] = await exited
  assert.equal(code, 0)
  assert.equal(stdout, '')
  assert.equal(stderr, '')
})

test('official Inspector CLI discovers and calls the TypeScript server', { timeout: 15000 }, () => {
  const inspector = here + 'node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js'
  const result = spawnSync(process.execPath, [inspector, '--cli', process.execPath, here + 'server.ts', '--method', 'tools/call', '--tool-name', 'project_sample', '--tool-arg', 'text=كلاس ۱۲۳ Java'], { cwd: here, encoding: 'utf8', timeout: 12000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.structuredContent.normalized, 'کلاس 123 java')
  assert.equal(output.structuredContent.scope, 'sample-only')
})
