// pnpm --filter desktop bench:ipc [seconds] — typing at 10 keys/s through the editor; p50/p95 of store_commit.
import { appEnv, build, runApp, sandbox } from './lib.mjs'

if (!process.env.NO_BUILD) build()
const r = await runApp(['--bench'], appEnv(sandbox(), { NEVIS_BENCH_SECONDS: process.argv[2] ?? '60' }), 300_000)
console.log(r.out.trim())
process.exitCode = r.code
