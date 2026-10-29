/** Read the approved temporary credential once and share it only with the two acceptance clients. */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceEndpoint, acceptanceToken } from './acceptance-auth.mjs'
const [endpoint, fixturePath, grantId, outputDirectory] = process.argv.slice(2)
acceptanceEndpoint(endpoint)
const output = resolve(outputDirectory ?? '')
if (!output.startsWith('/tmp/nevis-mcp-acceptance/')) throw new Error('Use the disposable acceptance output directory')
await mkdir(output, { recursive: true })
const token = acceptanceToken(grantId, endpoint), here = dirname(fileURLToPath(import.meta.url))
for (const [file, destination] of [['workflow.mjs', `${output}/sdk-report.json`], ['agent-workflow.mjs', output]]) {
  const child = spawn(process.execPath, [`${here}/${file}`, endpoint, fixturePath, grantId, destination], { env: { ...process.env, NEVIS_ACCEPTANCE_TOKEN: token }, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  if (code !== 0) { process.exitCode = code ?? 1; break }
}
