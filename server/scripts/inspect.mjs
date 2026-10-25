// `node scripts/inspect.mjs <server url> <user name> <password>`
// Looks at what the server really holds for an account, without the app: the vaults, their files, which device changed
// each one and when. Run it before and after saving a page in the app: the page's file appears here with a new `rev`.
// It signs in as a separate device (named "inspect") and signs out again at the end, so nothing is left behind.

const [base, username, password] = [process.argv[2]?.replace(/\/$/, ''), process.argv[3], process.argv[4]]
if (!base || !username || !password) {
  console.error('usage: node scripts/inspect.mjs <server url> <user name> <password>')
  process.exitCode = 2
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => undefined)
  return { status: res.status, json }
}

async function main() {
if (!base || !username || !password) return
const health = await api('GET', '/v1/health')
if (health.json?.name !== 'noviq-sync') {
  throw new Error(`${base} is not a Noviq sync server (it answered ${health.status}).`)
}
const login = await api('POST', '/v1/auth/login', { body: { username, password, device_name: 'inspect' } })
if (login.status !== 200) {
  throw new Error(`sign-in failed: ${login.json?.error ?? login.status}`)
}
const token = login.json.token
const when = (t) => (t ? new Date(t).toLocaleString() : '-')
try {
  const account = (await api('GET', '/v1/account', { token })).json
  console.log(`account ${account.user.username} on ${base}`)
  console.log(`storage ${(account.quota.used / 1048576).toFixed(1)} MB of ${(account.quota.limit / 1048576).toFixed(0)} MB`)
  console.log('devices:')
  for (const d of account.devices) console.log(`  ${d.name}${d.name === 'inspect' ? ' (this check)' : ''}  last active ${when(d.last_seen)}`)

  const vaults = (await api('GET', '/v1/vaults', { token })).json.vaults
  if (!vaults.length) console.log('no vaults yet: nothing has been synced')
  for (const v of vaults) {
    const state = (await api('GET', `/v1/vaults/${v.id}/state`, { token })).json
    console.log(`\nvault "${v.name}" (${v.id})  rev ${state.seq}, ${state.files} files, ${(v.bytes / 1024).toFixed(0)} KB`)
    const names = new Map()
    for (let since = 0; ; ) {
      const page = (await api('GET', `/v1/vaults/${v.id}/changes?since=${since}&limit=500`, { token })).json
      for (const f of page.files) names.set(f.path, f)
      since = page.next
      if (!page.has_more) break
    }
    const files = [...names.values()].sort((a, b) => b.rev - a.rev)
    for (const f of files.slice(0, 15)) console.log(`  rev ${String(f.rev).padStart(4)}  ${f.deleted ? 'deleted' : String(f.size).padStart(7) + ' B'}  ${when(f.server_time)}  ${f.path}`)
    if (files.length > 15) console.log(`  … and ${files.length - 15} more`)
  }
} finally {
  await api('POST', '/v1/auth/logout', { token })
}
}

main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
