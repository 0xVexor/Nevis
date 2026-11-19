import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Checkbox, Dialog, Facts, Field, Icon, IconButton, Notice, SegmentedChoice, Steps, WorkspaceHeader, useMenu, type MenuItem } from '../design-system'
import { BrandMark } from '../BrandMark'
import { AccentSwatches } from '../settings-ui/AccentSwatches'
import { updateSettings, useSettings } from '../settings'
import { t } from '../i18n'
import type { VaultEntry } from '../db'
import { formatBytes, purgeError, syncError, type ServerHealth, type ServerVault, type SyncStatus, type TrashedVault } from '../sync/client'
import { PurgeDialog } from '../sync/PurgeDialog'

/** What first launch needs from the desktop backend. The preview passes in-memory fakes. */
export interface WorkspaceServices {
  list: () => Promise<VaultEntry[]>
  pickFolder: (title: string) => Promise<string | null>
  create: (parent: string, name: string) => Promise<unknown>
  add: (path: string) => Promise<unknown>
  open: (id: string) => Promise<unknown>
  locate: (id: string, path: string) => Promise<unknown>
  forget: (id: string) => Promise<unknown>
  explain: (error: unknown) => string
  /** Sync with the person's own server, so existing workspaces can be brought here. Absent in the browser and when sync is off: the flow then has no sign-in step. */
  cloud?: {
    status: () => Promise<Pick<SyncStatus, 'signedIn' | 'username' | 'server' | 'defaultServer'>>
    login: (server: string, username: string, password: string) => Promise<void>
    vaults: () => Promise<ServerVault[]>
    /** Moves a workspace of the account to the server's trash (restorable for a while). Files on computers stay. */
    delete: (id: string) => Promise<unknown>
    /** The account's workspaces in the server's trash. */
    trashed: () => Promise<TrashedVault[]>
    restore: (id: string) => Promise<unknown>
    /** Removes a workspace in the server's trash for good. */
    purge: (id: string) => Promise<unknown>
    download: (id: string, name: string, parent: string) => Promise<void>
    logout: () => Promise<void>
    /** Makes an account and signs in; resolves to the one-time recovery key. */
    register: (server: string, username: string, password: string, invite: string) => Promise<string>
    /** What the server says about itself, e.g. whether it takes new accounts. */
    health: (server: string) => Promise<ServerHealth>
    /** Asks where to save the recovery key and writes it there; false when the person closed the dialog. */
    saveKey: (username: string, key: string) => Promise<boolean>
    copyKey: (key: string) => Promise<void>
    /** Turns sync on for the workspace that was just created (it is the open one). */
    enableSync: () => Promise<void>
  }
}

type Stage = 'loading' | 'list' | 'welcome' | 'name' | 'place' | 'signin' | 'signup' | 'recovery' | 'cloud' | 'landing'
const FLOW: Stage[] = ['welcome', 'name', 'place']

/** First launch and “All workspaces…”: a short flow that ends inside the new workspace, or the list of known ones. */
export function Onboarding({ services, onOpened }: { services: WorkspaceServices; onOpened: (workspace: { name: string; created: boolean }) => void }) {
  const settings = useSettings()
  const [stage, setStage] = useState<Stage>('loading')
  const [back, setBack] = useState(false)
  const [workspaces, setWorkspaces] = useState<VaultEntry[]>([])
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const { open: openMenu, menu } = useMenu()
  const heading = useRef<HTMLHeadingElement>(null)
  const shownName = name.trim() || t('My notes')
  const [landing, setLanding] = useState('')
  const [handoff, setHandoff] = useState(false)
  // Bringing a workspace from the person's server: where they came from, the sign-in form and the account's workspaces (null until loaded).
  const [origin, setOrigin] = useState<'welcome' | 'list'>('welcome')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [account, setAccount] = useState<{ username: string | null; server: string } | null>(null)
  const [cloudVaults, setCloudVaults] = useState<ServerVault[] | null>(null)
  const [trashed, setTrashed] = useState<TrashedVault[]>([])
  // The workspace the person is being asked about: to move to the server's trash, or to remove from it for good.
  const [removing, setRemoving] = useState<ServerVault | null>(null)
  const [purging, setPurging] = useState<TrashedVault | null>(null)
  // The server a release build is fixed to (empty in dev builds): then the address is not asked for, unless the person wants another server.
  const [defaultServer, setDefaultServer] = useState('')
  const [customServer, setCustomServer] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [invite, setInvite] = useState('')
  // What the server says about new accounts: null until asked (or after the address changed).
  const [registration, setRegistration] = useState<'open' | 'invite' | 'closed' | null>(null)
  const [signupFrom, setSignupFrom] = useState<'welcome' | 'signin'>('welcome')
  // The one-time recovery key lives only here, until the person goes on.
  const [recoveryKey, setRecoveryKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [keyNote, setKeyNote] = useState('')
  // Where “new workspace” was started: the offline path (welcome), the list, or the person's server.
  const [newFrom, setNewFrom] = useState<'welcome' | 'list' | 'cloud' | null>(null)
  const [syncNew, setSyncNew] = useState(true)
  // Set when the workspace exists but turning sync on failed: the person opens it from here, since creating it again would fail.
  const [created, setCreated] = useState('')
  const cloud = services.cloud

  const refresh = useCallback(async () => {
    const list = await services.list()
    setWorkspaces(list)
    return list
  }, [services])

  useEffect(() => {
    refresh()
      .then((list) => setStage(list.length ? 'list' : 'welcome'))
      .catch((e) => (setError(services.explain(e)), setStage('welcome')))
  }, [refresh, services])

  // A new step is announced and reachable by keyboard from its heading.
  useEffect(() => {
    if (stage !== 'loading' && stage !== 'landing') heading.current?.focus({ preventScroll: true })
  }, [stage])

  const go = (next: Stage, reverse = (FLOW.includes(next) && FLOW.indexOf(next) < FLOW.indexOf(stage)) || next === 'list') => {
    setBack(reverse)
    setError('')
    setStage(next)
  }

  const startNew = (from: 'welcome' | 'list' | 'cloud') => {
    setNewFrom(from)
    go('name')
  }

  const run = async (label: string, task: () => Promise<unknown>, explain = services.explain) => {
    setBusy(label)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(explain(e))
    } finally {
      await refresh().catch((e) => setError((previous) => previous || services.explain(e)))
      setBusy('')
    }
  }

  // The flow ends by growing the preview into the workspace; reduced motion skips the wait.
  // A new workspace hands over to its first note: the last frame stays put, and the next screen draws it again (LandingFrame).
  const land = (workspace: { name: string; created: boolean }) => {
    setLanding(workspace.name)
    setHandoff(workspace.created)
    setStage('landing')
    const reduce = settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => onOpened(workspace), reduce ? 0 : 640)
  }

  const loadAccount = async () => {
    setAccount(await cloud!.status().then((s) => ({ username: s.username, server: s.server })))
    const [vaults, inTrash] = await Promise.all([cloud!.vaults(), cloud!.trashed()])
    setTrashed(inTrash)
    setCloudVaults(vaults)
  }
  // Already signed in (say, to the same server from an earlier run): straight to the workspaces.
  const startCloud = (from: 'welcome' | 'list') =>
    run(
      'cloud',
      async () => {
        const status = await cloud!.status()
        setOrigin(from)
        setDefaultServer(status.defaultServer)
        setCloudVaults(null)
        if (!server) setServer((status.signedIn ? status.server : status.defaultServer) || status.server)
        if (status.signedIn) {
          go('cloud')
          await loadAccount()
        } else go('signin')
      },
      syncError,
    )
  const signIn = () =>
    run(
      'signin',
      async () => {
        await cloud!.login(server.trim(), username.trim(), password)
        setPassword('')
        setCloudVaults(null)
        go('cloud')
        await loadAccount()
      },
      syncError,
    )
  // Sign-up, from the welcome choices or from the sign-in form; the server address is prefilled the same way.
  const startSignup = (from: 'welcome' | 'signin') =>
    run(
      'signup-start',
      async () => {
        const status = await cloud!.status()
        const address = server || (status.signedIn ? status.server : status.defaultServer) || status.server
        setServer(address)
        setDefaultServer(status.defaultServer)
        if (from === 'welcome') setOrigin('welcome')
        setSignupFrom(from)
        setRegistration(null)
        go('signup')
        // the address is not on screen to be blurred: learn right away whether an invite code is needed or accounts are closed
        if (status.defaultServer && address === status.defaultServer) await askRegistration(address)
      },
      syncError,
    )
  const askRegistration = async (address = server.trim()) => {
    const health = await cloud!.health(address)
    const mode = health.registration === 'closed' || health.registration === 'invite' ? health.registration : 'open'
    setRegistration(mode)
    return mode
  }
  // On leaving the address field: the person learns early that the server does not take new accounts.
  const checkServer = () => {
    if (!server.trim() || registration) return
    askRegistration().catch((e) => setError(syncError(e)))
  }
  const showServerField = !defaultServer || customServer || (!!server.trim() && server.trim() !== defaultServer)
  // The quiet line that replaces the address field: which server this is, and a way to use another.
  const serverLine = !showServerField && (
    <p className="onb-aside">
      {t('Server:')} <bdi dir="ltr">{server.trim().replace(/^https?:\/\//, '')}</bdi>{' '}
      <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setCustomServer(true)}>
        {t('Use a different server')}
      </Button>
    </p>
  )
  const passwordLength = [...password].length
  const signUpReady = !!server.trim() && !!username.trim() && passwordLength >= 8 && password === confirm && registration !== 'closed' && (registration !== 'invite' || !!invite.trim())
  const signUp = () =>
    run(
      'signup',
      async () => {
        const mode = registration ?? (await askRegistration())
        if (mode === 'closed') return
        const key = await cloud!.register(server.trim(), username.trim(), password, invite.trim())
        setAccount({ username: username.trim(), server: server.trim() })
        setPassword('')
        setConfirm('')
        setInvite('')
        setRecoveryKey(key)
        setKeySaved(false)
        setKeyNote('')
        go('recovery')
      },
      syncError,
    )
  const copyKey = async () => {
    try {
      await cloud!.copyKey(recoveryKey)
      setKeyNote(t('Copied.'))
    } catch {
      setKeyNote(t('Copying did not work. Select the key and copy it by hand.'))
    }
  }
  const saveKey = async () => {
    try {
      if (await cloud!.saveKey(account?.username ?? username.trim(), recoveryKey)) setKeyNote(t('Saved.'))
    } catch (e) {
      setKeyNote(syncError(e))
    }
  }
  const afterRecovery = () =>
    run(
      'cloud',
      async () => {
        setRecoveryKey('')
        setCloudVaults(null)
        go('cloud')
        await loadAccount()
      },
      syncError,
    )
  const signOut = () =>
    run(
      'signout',
      async () => {
        await cloud!.logout()
        setCloudVaults(null)
        setTrashed([])
        setAccount(null)
        go('signin', true)
      },
      syncError,
    )
  const download = (v: ServerVault) =>
    run(
      'download' + v.id,
      async () => {
        const dir = await services.pickFolder(t('Choose the folder to put “{name}” in', { name: v.name }))
        if (!dir) return
        await cloud!.download(v.id, v.name, dir)
        land({ name: v.name, created: false })
      },
      syncError,
    )
  // After each of these the lists are read again; the dialog stays open when the server refused.
  const removeFromServer = (v: ServerVault) =>
    run(
      'remove' + v.id,
      async () => {
        await cloud!.delete(v.id)
        setRemoving(null)
        await loadAccount()
      },
      syncError,
    )
  const restoreFromTrash = (v: TrashedVault) =>
    run(
      'restore' + v.id,
      async () => {
        await cloud!.restore(v.id)
        await loadAccount()
      },
      syncError,
    )
  const purgeFromServer = (v: TrashedVault) =>
    run(
      'purge' + v.id,
      async () => {
        await cloud!.purge(v.id)
        setPurging(null)
        await loadAccount()
      },
      purgeError,
    )
  const choose = () =>
    run('choose', async () => {
      const dir = await services.pickFolder(t('Choose where to create the workspace'))
      if (dir) setParent(dir)
    })
  const create = () =>
    run('create', async () => {
      if (!parent) return
      await services.create(parent, shownName)
      if (syncOption && syncNew) {
        try {
          await cloud!.enableSync()
        } catch (e) {
          setCreated(shownName)
          setError(`${syncError(e)} ${t('The workspace was created. You can turn sync on later in Settings → Sync.')}`)
          return
        }
      }
      land({ name: shownName, created: true })
    })
  const openExisting = () =>
    run('add', async () => {
      const dir = await services.pickFolder(t('Choose a workspace folder'))
      if (!dir) return
      await services.add(dir)
      land({ name: dir.split(/[\\/]/).filter(Boolean).pop() || dir, created: false })
    })
  const openOne = (v: VaultEntry) => run('open' + v.id, async () => (await services.open(v.id), land({ name: v.name, created: false })))
  const locate = (v: VaultEntry) =>
    run('locate' + v.id, async () => {
      const dir = await services.pickFolder(t('Choose the folder of “{name}”', { name: v.name }))
      if (dir) await services.locate(v.id, dir)
    })
  const forget = (v: VaultEntry) => run('forget' + v.id, () => services.forget(v.id))

  const rowMenu = (v: VaultEntry): MenuItem[] => {
    const items: MenuItem[] = []
    if (v.exists) items.push({ label: 'Open', icon: <Icon name="folder-open" />, onSelect: () => void openOne(v) })
    if (v.status !== 'ok') items.push({ label: 'Locate folder…', icon: <Icon name="search" />, onSelect: () => void locate(v) })
    if (items.length) items.push({ kind: 'sep' })
    items.push({ label: 'Remove from the list (files stay on disk)', icon: <Icon name="x" />, danger: true, onSelect: () => void forget(v) })
    return items
  }

  const language = (
    <SegmentedChoice
      label={t('Interface language')}
      value={settings.lang}
      items={[
        { value: 'en', label: 'English' },
        { value: 'fa', label: 'فارسی' },
      ]}
      onChange={(lang) => updateSettings({ lang })}
    />
  )
  const fromList = workspaces.length > 0
  // Someone who already has workspaces, or who comes from their server, skips the welcome step, so their flow has two steps.
  const flow = fromList || newFrom === 'cloud' ? FLOW.slice(1) : FLOW
  const step = flow.indexOf(stage)
  // Signed in to the server, the new workspace can be synced right away (never on the offline path).
  const syncOption = !!account && (newFrom === 'cloud' || newFrom === 'list')
  const notice = error && (
    <Notice tone="bad" icon={<Icon name="error" />}>
      <p dir="auto">{error}</p>
    </Notice>
  )
  const backButton = (to: Stage) => (
    <Button variant="ghost" icon={<Icon name="arrow-left" className="ds-flip" />} disabled={!!busy} onClick={() => go(to, true)}>
      {t('Back')}
    </Button>
  )

  let body: ReactNode = null
  if (stage === 'welcome')
    body = (
      <section className="onb-panel onb-panel--center">
        <BrandMark size={48} className="onb-mark" />
        <h1 ref={heading} tabIndex={-1}>{t('Welcome to Nevis')}</h1>
        <p>{t('A calm place for notes, study and ideas. Everything stays in a folder on your computer.')}</p>
        <div className="onb-field">
          <span>{t('Language')}</span>
          {language}
        </div>
        {notice}
        {cloud ? (
          <div className="onb-choices" role="group" aria-labelledby="onb-ask">
            <p id="onb-ask" className="onb-ask">{t('How would you like to start?')}</p>
            <Choice icon="user" title={t('Sign in')} hint={t('I already have an account. Use my existing workspaces.')} busy={busy === 'cloud'} disabled={!!busy} onClick={() => void startCloud('welcome')} />
            <Choice icon="cloud" title={t('Create an account')} hint={t('Sync my workspaces between my devices.')} busy={busy === 'signup-start'} disabled={!!busy} onClick={() => void startSignup('welcome')} />
            <Choice icon="folder" title={t('Continue offline')} hint={t('No account. Everything stays on this computer. You can add sync later in Settings → Sync.')} disabled={!!busy} onClick={() => startNew('welcome')} />
          </div>
        ) : (
          <div className="onb-actions">
            <Button variant="primary" onClick={() => startNew('welcome')}>
              {t('Get started')}
              <Icon name="arrow-right" className="ds-flip" />
            </Button>
          </div>
        )}
      </section>
    )
  else if (stage === 'name')
    body = (
      <section className="onb-split">
        <form
          className="onb-panel"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            go('place')
          }}
        >
          <h1 ref={heading} tabIndex={-1}>{t('Name your workspace')}</h1>
          <p>{t('One workspace for each part of your life works well: study, work, a project. You can rename it later.')}</p>
          <label className="onb-field">
            <span>{t('Workspace name')}</span>
            <Field value={name} placeholder={t('My notes')} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="onb-field">
            <span>{t('Accent color')}</span>
            <AccentSwatches />
          </div>
          <div className="onb-actions">
            {backButton(newFrom === 'cloud' ? 'cloud' : fromList ? 'list' : 'welcome')}
            <Button variant="primary" type="submit">
              {t('Continue')}
              <Icon name="arrow-right" className="ds-flip" />
            </Button>
          </div>
        </form>
        <WorkspacePreview name={shownName} />
      </section>
    )
  else if (stage === 'place')
    body = (
      <section className="onb-panel">
        <h1 ref={heading} tabIndex={-1}>{t('Choose where it lives')}</h1>
        <p>{t('A workspace is an ordinary folder on this computer. Your pages, images and history stay there, in files you own.')}</p>
        <Facts
          items={[
            [t('Workspace'), shownName],
            [t('Location'), parent ? <bdi dir="ltr">{parent}</bdi> : <span className="onb-muted">{t('Not chosen yet')}</span>],
          ]}
        />
        <div className="onb-row">
          <Button icon={<Icon name="folder" />} disabled={!!busy || !!created} onClick={() => void choose()}>
            {parent ? t('Change folder…') : t('Choose a folder…')}
          </Button>
        </div>
        {syncOption && (
          <div className="onb-field">
            <Checkbox checked={syncNew} disabled={!!busy || !!created} onChange={setSyncNew}>
              {t('Sync this workspace with your server')}
            </Checkbox>
            <small className="onb-muted">
              <bdi dir="ltr">{account!.server}</bdi>
            </small>
          </div>
        )}
        {notice}
        <div className="onb-actions">
          {created ? <span /> : backButton('name')}
          {created ? (
            <Button variant="primary" onClick={() => land({ name: created, created: true })}>
              {t('Open workspace')}
            </Button>
          ) : (
            <Button variant="primary" disabled={!parent || !!busy} aria-busy={busy === 'create'} onClick={() => void create()}>
              {busy === 'create' ? t('Creating…') : t('Create workspace')}
            </Button>
          )}
        </div>
        {!created && <p className="onb-aside">
          {t('Already have a workspace?')}{' '}
          <Button variant="ghost" size="sm" icon={<Icon name="folder-open" />} disabled={!!busy} onClick={() => void openExisting()}>
            {t('Open a workspace folder…')}
          </Button>
        </p>}
      </section>
    )
  else if (stage === 'list')
    body = (
      <section className="onb-panel onb-panel--wide">
        <h1 ref={heading} tabIndex={-1}>{t('Choose a workspace')}</h1>
        <p>{t('A workspace is a folder that holds all the pages, images and history of one part of your work.')}</p>
        {notice}
        <ul className="onb-list">
          {workspaces.map((v) => (
            <li
              key={v.id}
              className={v.status === 'ok' ? undefined : 'is-unavailable'}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(rowMenu(v), e)
              }}
            >
              <Icon name="vault" />
              <div className="onb-list-text">
                <b dir="auto">{v.name}</b>
                <small><bdi dir="ltr">{v.path}</bdi></small>
                {v.status === 'missing' && <Notice tone="warn" role="note" compact>{t('Folder not found')}</Notice>}
                {v.status === 'mismatch' && <Notice tone="warn" role="note" compact>{t('A different vault is in this folder.')}</Notice>}
              </div>
              <div className="onb-list-actions">
                {v.status !== 'ok' && (
                  <Button size="sm" disabled={!!busy} onClick={() => void locate(v)}>
                    {t('Locate folder…')}
                  </Button>
                )}
                <Button size="sm" disabled={!v.exists || !!busy} aria-busy={busy === 'open' + v.id} onClick={() => void openOne(v)}>
                  {t('Open')}
                </Button>
                <IconButton label={t('More actions')} disabled={!!busy} onClick={(e) => openMenu(rowMenu(v), e.currentTarget)}>
                  <Icon name="more-horizontal" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
        <div className="onb-actions onb-actions--start">
          <Button variant="primary" icon={<Icon name="plus" />} disabled={!!busy} onClick={() => startNew('list')}>
            {t('New workspace')}
          </Button>
          <Button variant="ghost" icon={<Icon name="folder-open" />} disabled={!!busy} onClick={() => void openExisting()}>
            {t('Open a workspace folder…')}
          </Button>
          {cloud && (
            <Button variant="ghost" icon={<Icon name="cloud" />} disabled={!!busy} aria-busy={busy === 'cloud'} onClick={() => void startCloud('list')}>
              {t('Bring a workspace from your server…')}
            </Button>
          )}
        </div>
      </section>
    )
  else if (stage === 'signin')
    body = (
      <form
        className="onb-panel"
        aria-busy={busy === 'signin'}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          if (!busy && server.trim() && username.trim() && password) void signIn()
        }}
      >
        <h1 ref={heading} tabIndex={-1}>{t('Sign in to your server')}</h1>
        <p>{t('Bring the workspaces you already sync to this computer.')}</p>
        {showServerField && (
          <label className="onb-field">
            <span>{t('Server address')}</span>
            <Field ltr value={server} placeholder="sync.example.com" autoComplete="url" autoCapitalize="off" spellCheck={false} onChange={(e) => setServer(e.target.value)} />
            <small className="onb-muted">{t('For example sync.example.com')}</small>
          </label>
        )}
        <label className="onb-field">
          <span>{t('User name')}</span>
          <Field ltr value={username} autoComplete="username" autoCapitalize="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="onb-field">
          <span>{t('Password')}</span>
          <Field ltr type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {serverLine}
        {notice}
        <div className="onb-actions">
          {backButton(origin)}
          <Button variant="primary" type="submit" disabled={!!busy || !server.trim() || !username.trim() || !password} aria-busy={busy === 'signin'}>
            {busy === 'signin' ? t('Signing in…') : t('Sign in')}
          </Button>
        </div>
        <p className="onb-aside">
          {t('No account yet?')}{' '}
          <Button variant="ghost" size="sm" icon={<Icon name="user" />} disabled={!!busy} aria-busy={busy === 'signup-start'} onClick={() => void startSignup('signin')}>
            {t('Create an account')}
          </Button>
        </p>
      </form>
    )
  else if (stage === 'signup')
    body = (
      <form
        className="onb-panel"
        aria-busy={busy === 'signup'}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          if (!busy && signUpReady) void signUp()
        }}
      >
        <h1 ref={heading} tabIndex={-1}>{t('Create an account')}</h1>
        <p>{t('Sync keeps your workspaces the same on all your devices. Files are sent only to the server shown below, and only for workspaces with sync turned on.')}</p>
        {showServerField && (
          <label className="onb-field">
            <span>{t('Server address')}</span>
            <Field
              ltr
              value={server}
              placeholder="sync.example.com"
              autoComplete="url"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => (setServer(e.target.value), setRegistration(null))}
              onBlur={checkServer}
            />
            <small className="onb-muted">{t('For example sync.example.com')}</small>
          </label>
        )}
        {registration === 'closed' && (
          <Notice tone="warn" icon={<Icon name="lock" />} role="status">
            <p dir="auto">{t('This server does not take new accounts.')}</p>
          </Notice>
        )}
        {registration === 'invite' && (
          <label className="onb-field">
            <span>{t('Invite code')}</span>
            <Field ltr value={invite} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => setInvite(e.target.value)} />
            <small className="onb-muted">{t('This server takes new accounts only with a code from its owner.')}</small>
          </label>
        )}
        <label className="onb-field">
          <span>{t('User name')}</span>
          <Field ltr value={username} autoComplete="username" autoCapitalize="off" spellCheck={false} aria-describedby="onb-username-hint" onChange={(e) => setUsername(e.target.value)} />
          <small id="onb-username-hint" className="onb-muted">{t('Use 3 to 32 letters, digits, dots, dashes or underscores for the user name.')}</small>
        </label>
        <label className="onb-field">
          <span>{t('Password')}</span>
          <Field ltr type="password" value={password} autoComplete="new-password" aria-describedby="onb-password-hint" onChange={(e) => setPassword(e.target.value)} />
          <small id="onb-password-hint" className="onb-muted">{t('Use at least 8 characters.')}</small>
        </label>
        <label className="onb-field">
          <span>{t('Confirm password')}</span>
          <Field ltr type="password" value={confirm} autoComplete="new-password" aria-invalid={!!confirm && confirm !== password} aria-describedby={confirm && confirm !== password ? 'onb-confirm-hint' : undefined} onChange={(e) => setConfirm(e.target.value)} />
          {!!confirm && confirm !== password && <small id="onb-confirm-hint" role="alert">{t('The two passwords do not match.')}</small>}
        </label>
        {serverLine}
        {notice}
        <div className="onb-actions">
          {backButton(signupFrom)}
          {registration !== 'closed' && (
            <Button variant="primary" type="submit" disabled={!!busy || !signUpReady} aria-busy={busy === 'signup'}>
              {busy === 'signup' ? t('Creating…') : t('Create account')}
            </Button>
          )}
        </div>
      </form>
    )
  else if (stage === 'recovery')
    body = (
      <section className="onb-panel">
        <h1 ref={heading} tabIndex={-1}>{t('Your recovery key')}</h1>
        <p>{t('If you forget your password, this key is the only way back into your account. It is shown once. Keep it somewhere safe, outside this computer.')}</p>
        <div className="onb-key">
          <bdi dir="ltr">
            <code>{recoveryKey}</code>
          </bdi>
        </div>
        <div className="onb-row onb-row--gap">
          <Button icon={<Icon name="copy" />} onClick={() => void copyKey()}>
            {t('Copy')}
          </Button>
          <Button icon={<Icon name="save" />} onClick={() => void saveKey()}>
            {t('Save to a file…')}
          </Button>
        </div>
        {keyNote && <p className="onb-aside" role="status">{keyNote}</p>}
        <Checkbox checked={keySaved} onChange={setKeySaved}>
          {t('I saved my recovery key')}
        </Checkbox>
        {notice}
        <div className="onb-actions">
          <Button variant="primary" disabled={!keySaved || !!busy} aria-busy={busy === 'cloud'} onClick={() => void afterRecovery()}>
            {t('Continue')}
            <Icon name="arrow-right" className="ds-flip" />
          </Button>
        </div>
      </section>
    )
  else if (stage === 'cloud')
    body = (
      <section className="onb-panel onb-panel--wide" aria-busy={busy === 'cloud' || busy === 'signin' || busy === 'signout'}>
        <h1 ref={heading} tabIndex={-1}>{t('Workspaces on your server')}</h1>
        {account && (
          <p>
            <bdi dir="auto">{account.username}</bdi> · <bdi dir="ltr">{account.server}</bdi>
          </p>
        )}
        {!removing && !purging && notice}
        {cloudVaults === null && !error && <p className="onb-muted" role="status">{t('Loading…')}</p>}
        {cloudVaults?.length === 0 && <p className="onb-muted">{t('No workspaces on this server yet')}</p>}
        {!!cloudVaults?.length && (
          <ul className="onb-list">
            {cloudVaults.map((v) => {
              const here = workspaces.find((w) => w.id === v.id)
              return (
                <li key={v.id}>
                  <Icon name="cloud" />
                  <div className="onb-list-text">
                    <b dir="auto">{v.name}</b>
                    <small>{`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`}</small>
                  </div>
                  <div className="onb-list-actions">
                    <Button size="sm" variant="danger" disabled={!!busy} onClick={() => (setError(''), setRemoving(v))}>
                      {t('Delete from server…')}
                    </Button>
                    {here ? (
                      <>
                        <span className="onb-muted">{t('On this computer')}</span>
                        <Button size="sm" disabled={!here.exists || !!busy} aria-busy={busy === 'open' + here.id} onClick={() => void openOne(here)}>
                          {t('Open')}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" icon={<Icon name="download" />} disabled={!!busy} aria-busy={busy === 'download' + v.id} onClick={() => void download(v)}>
                        {busy === 'download' + v.id ? t('Downloading…') : t('Download…')}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {trashed.length > 0 && (
          <>
            <h2>{t('Server trash')}</h2>
            <p className="onb-muted">{t('They are removed from the server for good after a while. Restore one to get it back.')}</p>
            <ul className="onb-list">
              {trashed.map((v) => (
                <li key={v.id}>
                  <Icon name="cloud" />
                  <div className="onb-list-text">
                    <b dir="auto">{v.name}</b>
                    <small>{`${v.files ?? 0} ${t('files')} · ${formatBytes(v.bytes)}`}</small>
                  </div>
                  <div className="onb-list-actions">
                    <Button size="sm" disabled={!!busy} aria-busy={busy === 'restore' + v.id} onClick={() => void restoreFromTrash(v)}>
                      {t('Restore')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={!!busy} onClick={() => (setError(''), setPurging(v))}>
                      {t('Delete permanently…')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {removing && (
          <Dialog
            open
            title={t('Delete “{name}” from the server?', { name: removing.name })}
            onClose={() => setRemoving(null)}
            actions={
              <>
                <Button disabled={!!busy} onClick={() => setRemoving(null)}>
                  {t('Cancel')}
                </Button>
                <Button variant="primary" disabled={!!busy} aria-busy={busy === 'remove' + removing.id} onClick={() => void removeFromServer(removing)}>
                  {t('Delete from server')}
                </Button>
              </>
            }
          >
            <div className="ds-modal-body">
              <p>
                <b dir="auto">{removing.name}</b>
              </p>
              <p>{t('It moves to the server’s trash and can be restored for 30 days. Files on any computer stay.')}</p>
              {notice}
            </div>
          </Dialog>
        )}
        {purging && <PurgeDialog vault={purging} busy={!!busy} error={error} onCancel={() => setPurging(null)} onConfirm={() => void purgeFromServer(purging)} />}
        <div className="onb-actions">
          {backButton(origin)}
          <span className="onb-row">
            {cloudVaults === null && error && (
              <Button icon={<Icon name="refresh" />} disabled={!!busy} onClick={() => void run('cloud', loadAccount, syncError)}>
                {t('Try again')}
              </Button>
            )}
            <Button variant="ghost" icon={<Icon name="user" />} disabled={!!busy} aria-busy={busy === 'signout'} onClick={() => void signOut()}>
              {t('Use another account')}
            </Button>
            <Button variant="primary" icon={<Icon name="plus" />} disabled={!!busy} onClick={() => startNew('cloud')}>
              {t('Start a new workspace')}
            </Button>
          </span>
        </div>
      </section>
    )
  else if (stage === 'landing')
    body = (
      <section className="onb-landing" role="status">
        <WorkspacePreview name={landing} />
        <p>{t('Opening {name}…', { name: landing })}</p>
      </section>
    )

  return (
    <div className="onb" data-stage={stage} data-handoff={handoff || undefined}>
      <header className="onb-top">
        <span className="onb-brand">
          <BrandMark size={20} />
          Nevis
        </span>
        {step >= 0 && <Steps count={flow.length} current={step} label={t('Step {n} of {total}', { n: step + 1, total: flow.length })} />}
        <span className="onb-top-end">{stage === 'list' && language}</span>
      </header>
      {/* Keyed by stage and language: each step enters with one short slide, a language switch crossfades. */}
      <main key={stage + settings.lang} className={'onb-stage' + (back ? ' is-back' : '')}>
        {body}
      </main>
      {menu}
    </div>
  )
}

/** One of the equal choices on the welcome screen: a real button with an icon, a title and a one-line description. */
function Choice({ icon, title, hint, busy, disabled, onClick }: { icon: string; title: string; hint: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="onb-choice" disabled={disabled} aria-busy={busy} onClick={onClick}>
      <Icon name={icon} />
      <span className="onb-choice-text">
        <b>{title}</b>
        <small>{hint}</small>
      </span>
      <Icon name="arrow-right" className="ds-flip" />
    </button>
  )
}

/** The start flow's last frame, drawn again after the reload that opens a new workspace so the two screens meet without a seam. */
export function LandingFrame({ name, leaving }: { name: string; leaving?: boolean }) {
  return (
    <div className={'onb' + (leaving ? ' is-leaving' : '')} data-stage="arrive" aria-hidden="true">
      <header className="onb-top">
        <span className="onb-brand">
          <BrandMark size={20} />
          Nevis
        </span>
        <span className="onb-top-end" />
      </header>
      <main className="onb-stage">
        <section className="onb-landing">
          <WorkspacePreview name={name} />
          <p>{t('Opening {name}…', { name })}</p>
        </section>
      </main>
    </div>
  )
}

/** The workspace taking shape: the real sidebar identity, with the name and accent as they are chosen. */
function WorkspacePreview({ name }: { name: string }) {
  const rows: [string, string][] = [
    ['search', 'Search'],
    ['home', 'Home'],
    ['file', 'Pages'],
    ['tasks', 'Tasks'],
  ]
  return (
    <div className="onb-preview" aria-hidden="true">
      <aside className="onb-preview-side">
        <WorkspaceHeader mark={<BrandMark />} name={<span dir="auto">{name}</span>} />
        {rows.map(([icon, label], i) => (
          <span key={icon} className={'onb-preview-row' + (i === 1 ? ' is-current' : '')}>
            <Icon name={icon} size={16} />
            {t(label)}
          </span>
        ))}
      </aside>
      <div className="onb-preview-page">
        <i className="onb-preview-line onb-preview-line--title" />
        <i className="onb-preview-line" />
        <i className="onb-preview-line onb-preview-line--short" />
        <i className="onb-preview-line onb-preview-line--accent" />
      </div>
    </div>
  )
}
