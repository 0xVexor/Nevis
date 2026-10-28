// Development-only UI fixtures. Native calls are mocked; no account/repository is contacted.
const params = new URLSearchParams(location.search)
const scenario = params.get('state') ?? 'connected'
const lang = params.get('lang') === 'fa' ? 'fa' : 'en'
localStorage.setItem('not.settings', JSON.stringify({ lang, theme: params.get('theme') ?? 'light', dir: 'auto' }))
const version = (title: string) => btoa(unescape(encodeURIComponent(JSON.stringify({ id: 'preview-page', title, parentId: null, tags: ['Research'], content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] }, database: { sourceId: 'source-1', values: { status: 'draft' } } }))))
const binding = { owner: 'preview-user', repo: 'noviq-data', branch: 'main', repo_id: 42, vault: 'preview-vault', quiet_seconds: 15, poll_seconds: 120, backup: '/Application Support/Noviq/github/backups/preview-vault-123' }
const calls: unknown[] = []
Object.assign(window, { __GH_PREVIEW_CALLS__: calls, __TAURI_INTERNALS__: {
  transformCallback: () => 1,
  invoke: async (cmd: string, args: Record<string, any>) => {
    calls.push({ cmd, args })
    if (cmd === 'pages_all') return []
    if (cmd === 'vault_stamp') return 'fixture'
    if (cmd === 'account_status') return { provider: 'github', signedIn: true, syncOn: true, state: scenario === 'offline' ? 'offline' : scenario === 'error' ? 'error' : 'idle', lastAt: 1793095200000, reason: '', error: scenario === 'error' ? 'GITHUB:rate_limited:120' : scenario === 'offline' ? 'GITHUB:network_connect:host=api.github.com;phase=account_profile;os=61' : '' }
    if (cmd === 'github_action') {
      if (args.action === 'status') return { configured: scenario !== 'unconfigured', signedIn: !['signedout', 'unconfigured', 'device'].includes(scenario), login: 'preview-user', binding: ['connected', 'conflicts', 'offline', 'error'].includes(scenario) ? binding : null, installationUrl: 'https://github.com/apps/preview/installations/new' }
      if (args.action === 'conflicts') return scenario === 'conflicts' ? [{ id: 'conflict-one', path: 'pages/preview-page.json', createdAt: Date.now(), local: version('ویرایش این دستگاه / Local edit'), remote: version('ویرایش دستگاه دیگر / Remote edit'), base: version('Original note') }] : []
      if (args.action === 'diagnostics') return { systemProxySupport: true, certificateValidation: true, checks: [{ host: 'api.github.com', reachable: true, httpStatus: 200 }] }
      if (args.action === 'begin') return { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 }
      if (args.action === 'poll') return { pending: true, interval: 5 }
      if (args.action === 'list') return [{ id: 'preview-vault', files: 120, connectedHere: false }]
      if (args.action === 'connect' && scenario === 'setup') throw 'GITHUB:installation_required'
      if (args.action === 'connect') return { backup: '/preview/verified-backup' }
      return null
    }
    return null
  },
} })
const [{ createRoot }, { GitHubAccountDialog }] = await Promise.all([import('react-dom/client'), import('../src/GitHubSync')])
await import('../src/index.css')
createRoot(document.getElementById('root')!).render(<GitHubAccountDialog onClose={() => {}} onLegacy={() => {}} />)
