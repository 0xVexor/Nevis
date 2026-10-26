// Entry point: `node src/main.ts`. Reads configuration from the environment (see .env.example).
import { loadConfig } from './config.ts'
import { createGateway } from './server.ts'

const cfg = loadConfig()
const gw = createGateway(cfg, { trustProxy: process.env.GATEWAY_TRUST_PROXY === '1' })
const stop = gw.startBackground()
gw.server.listen(cfg.port, cfg.host, () => {
  console.log(`Noviq gateway listening on http://${cfg.host}:${cfg.port} (db ${cfg.dbPath})`)
  if (!cfg.ownerToken) console.log(`Development owner token (loopback only, not saved anywhere): ${gw.ownerToken}`)
})
const shutdown = () => { stop(); void gw.close().then(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
