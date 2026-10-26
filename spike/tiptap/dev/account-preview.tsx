// Dev only: the account screens against a fake desktop backend, so that they can be looked at (and clicked through) in a plain browser.
//   npm run dev, then open /dev/account-preview.html?scene=<scene>&lang=fa&theme=dark
// Scenes: picker-first, picker-signed, signin, signup, recover, key, account, sync-error, offline, paused, signedout
// The fake answers like the real backend does (src-tauri/src/main.rs) but keeps everything in memory.

const q = new URLSearchParams(location.search)
const scene = q.get('scene') ?? 'picker-first'

const now = Date.now()
const signedIn = !['picker-first', 'signin', 'signup', 'recover', 'signedout'].includes(scene)
const mock = {
  signedIn,
  username: 'sara',
  registration: (q.get('registration') ?? 'invite') as 'open' | 'invite' | 'closed',
  state: scene === 'sync-error' ? 'error' : scene === 'offline' ? 'offline' : scene === 'paused' ? 'paused' : 'idle',
  reason: scene === 'paused' ? 'SIGNED_OUT' : '',
  syncOn: true,
  devices: [
    { id: 'd1', name: 'SARA-LAPTOP (windows)', created_at: now - 9e8, last_seen: now - 1000, current: true },
    { id: 'd2', name: 'Studio iMac (macos)', created_at: now - 5e8, last_seen: now - 3 * 3600e3, current: false },
    { id: 'd3', name: 'Office PC (windows)', created_at: now - 2e8, last_seen: now - 40 * 3600e3, current: false },
  ],
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const handlers: Record<string, (a: any) => unknown> = {
  account_status: () => ({
    signedIn: mock.signedIn,
    username: mock.signedIn ? mock.username : null,
    server: 'https://sync.manaz.pro',
    defaultServer: 'https://sync.manaz.pro',
    syncOn: mock.syncOn,
    state: mock.signedIn ? mock.state : 'off',
    lastAt: now - 4000,
    error: scene === 'sync-error' ? 'HUB:bad_path\npath=databases/views/example.json\ndetail=outside_vault\noperation=commit\nendpoint=https://sync.example.com/v1/vaults/example/commit' : '',
    reason: mock.reason,
  }),
  server_health: async () => (await wait(250), { ok: true, registration: mock.registration, pow_bits: 18, api: 1 }),
  account_register: async (a) => {
    await wait(700)
    if (a.username === 'taken') throw 'HUB:username_taken'
    mock.signedIn = true
    mock.username = a.username
    return 'K7QWE-9XRTM-ABCDF-HJNPS'
  },
  account_login: async (a) => {
    await wait(500)
    if (a.password !== 'correct horse') throw 'HUB:bad_credentials'
    mock.signedIn = true
    mock.username = a.username
  },
  account_recover: async () => (await wait(500), (mock.signedIn = true), 'WW4ZQ-2ABCD-MNPQR-TUVXY'),
  account_logout: async () => ((mock.signedIn = false), undefined),
  account_info: async () => (await wait(200), { user: { id: 'u', username: mock.username, created_at: now - 1e9 }, devices: mock.devices, quota: { used: 183 * 1048576, limit: 1024 * 1048576 }, vaults: 3 }),
  account_revoke_device: async (a) => ((mock.devices = mock.devices.filter((d) => d.id !== a.id)), undefined),
  account_change_password: async (a) => {
    if (a.oldPassword !== 'correct horse') throw 'HUB:bad_credentials'
  },
  account_new_recovery_key: async () => 'N3WKY-5ABCD-EFGHJ-KLMNP',
  account_delete: async () => now + 30 * 86400e3,
  cloud_vaults: async () => [
    { id: 'v1', name: 'My notes', files: 214, bytes: 31 * 1048576 },
    { id: 'v2', name: 'یادداشت‌های درس', files: 58, bytes: 4.2 * 1048576 },
    { id: 'v3', name: 'Work', files: 1203, bytes: 148 * 1048576 },
  ],
  cloud_trashed: async () => (scene === 'account' ? [{ id: 'v9', name: 'Old drafts', deletedAt: now - 3 * 86400e3 }] : []),
  cloud_restore: async () => undefined,
  vault_list: () => ({
    current: null,
    vaults:
      scene === 'picker-first' || ['signin', 'signup', 'recover'].includes(scene)
        ? []
        : [
            { id: 'v1', name: 'My notes', path: 'C:\\Users\\sara\\Documents\\My notes', sync: true, exists: true, status: 'ok' },
            ...(scene === 'vaults'
              ? [
                  { id: 'v2', name: 'Work', path: 'D:\\Work', sync: true, exists: true, status: 'ok' },
                  { id: 'v3', name: 'Old folder', path: 'E:\\gone', sync: false, exists: false, status: 'missing' },
                ]
              : []),
          ],
  }),
  vault_info: () => ({ id: 'v1', name: 'My notes', path: 'C:\\Users\\sara\\Documents\\My notes' }),
  sync_set: () => undefined,
  sync_now: () => undefined,
  sync_confirm: () => undefined,
  cloud_reupload: () => undefined,
}

;(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: unknown) => {
    const h = handlers[cmd]
    if (!h) throw `no fake for ${cmd}`
    return h(args ?? {})
  },
}

const [{ createRoot }, { StrictMode }, React] = await Promise.all([import('react-dom/client'), import('react'), import('react'), import('../src/index.css')])
const { updateSettings } = await import('../src/settings')
updateSettings({ lang: q.get('lang') === 'fa' ? 'fa' : 'en', theme: q.get('theme') === 'dark' ? 'dark' : 'light' })
const { AccountDialog, AuthFlow, KeyScreen, useAccountStatus } = await import('../src/Account')
const { VaultPicker } = await import('../src/VaultPicker')
const { Vaults } = await import('../src/Vaults')

function Scene() {
  const [st] = useAccountStatus()
  if (scene.startsWith('picker')) return <VaultPicker onOpened={() => {}} />
  if (scene === 'key')
    return (
      <div className="overlay"><div className="modal wsd acct"><div className="wsd-body"><KeyScreen keyText="K7QWE-9XRTM-ABCDF-HJNPS" username="sara" onDone={() => {}} /></div></div></div>
    )
  if (scene === 'signin' || scene === 'signup' || scene === 'recover')
    return (
      <div className="overlay"><div className="modal wsd acct"><div className="wsd-body"><AuthFlow status={st} initial={scene === 'signup' ? 'signup' : 'signin'} onDone={() => {}} /></div></div></div>
    )
  if (scene === 'vaults') return <Vaults onClose={() => {}} onNew={() => {}} onAccount={() => {}} />
  return <AccountDialog onClose={() => {}} onWorkspaces={() => {}} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Scene />
  </StrictMode>,
)
void React
