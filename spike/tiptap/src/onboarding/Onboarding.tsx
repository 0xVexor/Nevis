import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Facts, Field, Icon, IconButton, Notice, SegmentedChoice, Steps, WorkspaceHeader, useMenu, type MenuItem } from '../design-system'
import { BrandMark } from '../BrandMark'
import { AccentSwatches } from '../settings-ui/AccentSwatches'
import { updateSettings, useSettings } from '../settings'
import { t } from '../i18n'
import type { VaultEntry } from '../db'

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
}

type Stage = 'loading' | 'list' | 'welcome' | 'name' | 'place' | 'landing'
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

  const go = (next: Stage) => {
    setBack(FLOW.indexOf(next) < FLOW.indexOf(stage) || next === 'list')
    setError('')
    setStage(next)
  }

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(services.explain(e))
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

  const choose = () =>
    run('choose', async () => {
      const dir = await services.pickFolder(t('Choose where to create the workspace'))
      if (dir) setParent(dir)
    })
  const create = () =>
    run('create', async () => {
      if (!parent) return
      await services.create(parent, shownName)
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
  // Someone who already has workspaces skips the welcome step, so their flow has two steps.
  const flow = fromList ? FLOW.slice(1) : FLOW
  const step = flow.indexOf(stage)
  const notice = error && (
    <Notice tone="bad" icon={<Icon name="error" />}>
      <p dir="auto">{error}</p>
    </Notice>
  )
  const backButton = (to: Stage) => (
    <Button variant="ghost" icon={<Icon name="arrow-left" className="ds-flip" />} disabled={!!busy} onClick={() => go(to)}>
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
        <div className="onb-actions">
          <Button variant="primary" onClick={() => go('name')}>
            {t('Get started')}
            <Icon name="arrow-right" className="ds-flip" />
          </Button>
        </div>
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
            {backButton(fromList ? 'list' : 'welcome')}
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
          <Button icon={<Icon name="folder" />} disabled={!!busy} onClick={() => void choose()}>
            {parent ? t('Change folder…') : t('Choose a folder…')}
          </Button>
        </div>
        {notice}
        <div className="onb-actions">
          {backButton('name')}
          <Button variant="primary" disabled={!parent || !!busy} aria-busy={busy === 'create'} onClick={() => void create()}>
            {busy === 'create' ? t('Creating…') : t('Create workspace')}
          </Button>
        </div>
        <p className="onb-aside">
          {t('Already have a workspace?')}{' '}
          <Button variant="ghost" size="sm" icon={<Icon name="folder-open" />} disabled={!!busy} onClick={() => void openExisting()}>
            {t('Open a workspace folder…')}
          </Button>
        </p>
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
          <Button variant="primary" icon={<Icon name="plus" />} disabled={!!busy} onClick={() => go('name')}>
            {t('New workspace')}
          </Button>
          <Button variant="ghost" icon={<Icon name="folder-open" />} disabled={!!busy} onClick={() => void openExisting()}>
            {t('Open a workspace folder…')}
          </Button>
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
