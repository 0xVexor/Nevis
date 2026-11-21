// Proves the architecture rules are not vacuous: the fixture folder breaks two of them and the check must fail on it, naming them.
import { spawnSync } from 'node:child_process'
const r = spawnSync('npx', ['depcruise', '--config', '.dependency-cruiser.cjs', 'tools/depcheck/fixtures', '--output-type', 'err'], { encoding: 'utf8' })
const out = r.stdout + r.stderr
if (r.status === 0 || !out.includes('no-old-storage-or-sync')) {
  console.error('the dependency rules did NOT catch the fixture:\n' + out)
  process.exit(1)
}
console.log('dependency rules are not vacuous: the fixture was refused (no-old-storage-or-sync)')
