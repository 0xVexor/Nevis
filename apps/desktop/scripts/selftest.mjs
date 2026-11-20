// pnpm --filter desktop test:conformance — builds, starts a server, runs `Nevis --self-test`, exits with its code.
import { appEnv, build, runApp, sandbox, startServer } from './lib.mjs'

if (!process.env.NO_BUILD) build()
const srv = await startServer()
try {
  const r = await runApp(['--self-test'], appEnv(sandbox(), { NEVIS_SERVER: srv.url }))
  console.log(r.out.trim())
  process.exitCode = r.code
} finally { srv.stop() }
