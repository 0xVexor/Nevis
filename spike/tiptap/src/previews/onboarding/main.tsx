// The app loads the document store before the editor modules; the editor's page links read it during module setup.
import '../../store'
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { Onboarding, type WorkspaceServices } from '../../onboarding/Onboarding'
import { FirstNote } from '../../onboarding/FirstNote'
import { Button, Icon } from '../../design-system'
import { updateSettings } from '../../settings'
import { t } from '../../i18n'
import type { VaultEntry } from '../../db'
import type { ServerVault } from '../../sync/client'
import '../../index.css'
import './preview.css'

// Isolated, in-memory review of first launch. No vault, native dialog or store is touched.
// ?state=returning shows the workspace list; ?fail makes creating, opening, signing in and downloading fail once.
// ?cloud=1 adds the "sign in to your server" steps (password: any; user "empty" has no workspaces); ?signedin=1 starts signed in.
const query = new URLSearchParams(location.search)
updateSettings({ lang: query.get('lang') === 'fa' ? 'fa' : 'en', dir: 'auto', theme: query.get('theme') === 'dark' ? 'dark' : 'light', accent: query.get('accent'), reduceMotion: query.has('reduced') })

const known: VaultEntry[] = [
  { id: 'study', name: 'Study', path: 'C:\\Users\\me\\Documents\\Nevis\\Study', exists: true, status: 'ok' },
  { id: 'work', name: 'پروژه‌های کاری', path: 'D:\\Notes\\Work', exists: true, status: 'ok' },
  { id: 'usb', name: 'Thesis', path: 'E:\\Thesis', exists: false, status: 'missing' },
  { id: 'old', name: 'Archive', path: 'C:\\Users\\me\\Archive', exists: true, status: 'mismatch' },
]

const cloudVaults: ServerVault[] = [
  { id: 'study', name: 'Study', files: 128, bytes: 18 * 1024 * 1024 },
  { id: 'journal', name: 'دفتر روزانه', files: 342, bytes: 4 * 1024 * 1024 },
  { id: 'research', name: 'Research notes', files: 12, bytes: 300 * 1024 },
]

function fakeServices(): WorkspaceServices {
  let list = query.get('state') === 'returning' ? [...known] : []
  let fail = query.has('fail')
  const wait = () => new Promise((resolve) => setTimeout(resolve, 450))
  const maybeFail = (code = 'VAULT_IN_USE') => {
    if (!fail) return
    fail = false
    throw new Error(code)
  }
  let signedIn = query.has('signedin')
  let account = { username: 'sara', server: 'https://sync.example.com', vaults: cloudVaults }
  const cloud: WorkspaceServices['cloud'] = {
    status: async () => (await wait(), { signedIn, username: signedIn ? account.username : null, server: signedIn ? account.server : '', defaultServer: 'https://sync.example.com' }),
    login: async (server, username) => {
      await wait()
      maybeFail('HUB:bad_credentials')
      if (server.startsWith('http://')) throw new Error('HUB:insecure_server')
      signedIn = true
      account = { username, server, vaults: username === 'empty' ? [] : cloudVaults }
    },
    vaults: async () => (await wait(), account.vaults),
    download: async (id, name, parent) => {
      await wait()
      maybeFail('NETWORK:timeout')
      list = [...list, { id, name, path: parent + '\\' + name, exists: true, status: 'ok' }]
    },
    logout: async () => {
      await wait()
      signedIn = false
    },
  }
  return {
    cloud: query.has('cloud') ? cloud : undefined,
    list: async () => list,
    pickFolder: async () => (await wait(), 'C:\\Users\\me\\Documents\\Nevis'),
    create: async (parent, name) => (await wait(), maybeFail(), (list = [...list, { id: crypto.randomUUID(), name, path: parent + '\\' + name, exists: true, status: 'ok' }])),
    add: async (path) => (await wait(), maybeFail(), (list = [...list, { id: crypto.randomUUID(), name: 'Nevis', path, exists: true, status: 'ok' }])),
    open: async () => (await wait(), maybeFail()),
    locate: async (id, path) => (await wait(), (list = list.map((v) => (v.id === id ? { ...v, path, exists: true, status: 'ok' } : v)))),
    forget: async (id) => (list = list.filter((v) => v.id !== id)),
    explain: (e) => (String(e).includes('VAULT_IN_USE') ? t('This workspace is already open in another Nevis process. Close it there before opening it here.') : String(e)),
  }
}

type Scene = { at: 'onboarding' } | { at: 'first-note'; name: string; arrive: boolean } | { at: 'done'; page: string | null }

function Preview() {
  const [run, setRun] = useState(0)
  const [services, setServices] = useState(fakeServices)
  // ?scene=first-note opens the first page directly
  const [scene, setScene] = useState<Scene>(query.get('scene') === 'first-note' ? { at: 'first-note', name: t('My notes'), arrive: false } : { at: 'onboarding' })
  const draft = useRef<string | null>(null)
  const restart = () => ((draft.current = null), setServices(fakeServices), setScene({ at: 'onboarding' }), setRun(run + 1))
  if (scene.at === 'first-note') {
    return (
      <FirstNote
        workspace={scene.name}
        arrive={scene.arrive}
        onChange={() => (draft.current ??= crypto.randomUUID())}
        onPersist={() => new Promise((resolve) => setTimeout(resolve, 300))}
        onFinish={(page) => setScene({ at: 'done', page })}
      />
    )
  }
  if (scene.at === 'done')
    return (
      <div className="onb-preview-done">
        <p>{t(scene.page ? 'The workspace would open here, with the first note in the sidebar.' : 'The workspace would open here.')}</p>
        <Button icon={<Icon name="refresh" />} onClick={restart}>
          {t('Start over')}
        </Button>
      </div>
    )
  return <Onboarding key={run} services={services} onOpened={(workspace) => setScene(workspace.created ? { at: 'first-note', name: workspace.name, arrive: true } : { at: 'done', page: null })} />
}

createRoot(document.getElementById('root')!).render(<Preview />)
