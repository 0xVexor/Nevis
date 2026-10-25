// `npm run check`: puts, reads and deletes one small object in the configured storage, so that wrong S3 settings
// show up at deploy time with a clear message rather than on the first sync. Uses the same environment variables as the server.
import { loadConfig } from '../src/config.js'
import { createStorage } from '../src/storage.js'

const cfg = loadConfig()
console.log(`storage: ${cfg.storage}${cfg.storage === 's3' ? ` (${cfg.s3.endpoint}, bucket ${cfg.s3.bucket})` : ''}`)
const storage = await createStorage(cfg)
const key = `_check/${Date.now()}`
const body = Buffer.from('noviq storage check')
try {
  await storage.put(key, body)
  const back = await storage.read(key)
  if (!back || !back.equals(body)) throw new Error('what was read is not what was written')
  const listed = await storage.list('_check/')
  if (!listed.includes(key)) throw new Error('the object is not in the listing')
  await storage.del(key)
  if (await storage.has(key)) throw new Error('the object is still there after the delete')
  console.log('OK: write, read, list and delete work')
} catch (e) {
  console.error(`FAILED: ${e.name}: ${e.message}`)
  process.exit(1)
}
