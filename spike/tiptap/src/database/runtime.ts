// App wiring of the database feature: which storage adapter, which pages, which device. Everything else is in service.ts.
import { invoke } from '@tauri-apps/api/core'
import { db, isTauri, vaultInfo } from '../db'
import { repo } from '../store'
import type { Page } from '../repo'
import { DatabaseService } from './service'
import { IdbStorage } from './storage/idb'
import { TauriStorage } from './storage/tauri'
import type { PageHost } from './storage/types'
import type { PageLike } from './model/types'
import type { ExternalAdapter } from './workflows/outbox'
import type { PageStore } from './state'
import { dueReminders } from './reminders'
import { GatewayClient, gatewayConfig, pullInbox } from './gateway/client'

const DEVICE_KEY = 'not.deviceId' // per device, never synced: kv files travel with the vault, localStorage does not

function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) localStorage.setItem(DEVICE_KEY, (id = crypto.randomUUID()))
    return id
  } catch {
    throw new Error('DB:device_identity_unavailable')
  }
}

function weekStart(): number {
  try {
    const n = Number(localStorage.getItem('not.db.weekStart'))
    return Number.isInteger(n) && n >= 0 && n <= 6 && localStorage.getItem('not.db.weekStart') !== null ? n : 6
  } catch {
    return 6
  }
}

const pages: PageStore = { get: (id) => repo.getRaw(id) as PageLike | undefined, all: () => repo.allRaw() as unknown as PageLike[] }
const host: PageHost = {
  get: pages.get,
  all: pages.all,
  adopt: (upserts, removed) => repo.adoptDatabase(upserts as unknown as Page[], removed),
  flush: () => repo.flushForDatabase(),
}

const adapters: ExternalAdapter[] = []
/** Gateways / providers register their external effects here (webhook, email, Slack). Credentials stay outside the Vault. */
export const registerAdapter = (a: ExternalAdapter) => void adapters.push(a)

let instance: DatabaseService | null = null
let starting: Promise<DatabaseService> | null = null

/** The database service of the open vault, created once. Call after `initStore()`. */
export function getDatabase(): Promise<DatabaseService> {
  return (starting ??= (async () => {
    const vaultId = isTauri ? (await vaultInfo()).id : 'browser'
    const storage = isTauri ? new TauriStorage((cmd, args) => invoke(cmd, args)) : new IdbStorage(db)
    const svc = new DatabaseService({
      vaultId, storage, pages, host, deviceId: deviceId(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      runtime: storage.runtime(), adapters, weekStart: weekStart(),
    })
    await svc.open()
    instance = svc
    window.addEventListener('external-change', (e) => void svc.reloadExternal((e as CustomEvent<string[]>).detail))
    if (storage instanceof IdbStorage) {
      storage.onExternal(() => void repo.refreshFromStore().then(() => svc.reloadExternal()).catch((err) => console.error('database refresh', err)))
    }
    startJobs(svc)
    return svc
  })().catch(error => { starting = null; throw error }))
}

/** The service if it has been started (for code that must not wait, e.g. the graph). */
export const peekDatabase = () => instance

const JOB_EVERY = 60_000

/** Public form answers waiting on the gateway: apply them with this device's revision guards and acknowledge. Silent when no gateway is set up. */
async function pullGateway(svc: DatabaseService) {
  const cfg = gatewayConfig()
  if (!cfg) return
  try {
    const r = await pullInbox(svc, new GatewayClient(cfg))
    if (r.applied || r.rejected) window.dispatchEvent(new CustomEvent('db-gateway-inbox', { detail: r }))
  } catch (e) {
    console.warn('gateway inbox', e)
  }
}

/** Due date reminders: record the receipt first, then tell the person (in-app message, and a system notification if they allowed it). */
async function fireReminders(svc: DatabaseService) {
  for (const r of dueReminders(svc.state, svc.principalId, svc.now(), svc.zone)) {
    const res = await svc.tryExec([{ type: 'reminder.fire', payload: { pageId: r.pageId, propertyId: r.propertyId, offsetMinutes: r.offsetMinutes, startKey: r.startKey } }], { origin: 'automation' })
    if (!res.ok || !(res.result as { fired?: boolean }).fired) continue
    window.dispatchEvent(new CustomEvent(REMINDER_EVENT, { detail: r }))
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(r.title || r.propertyName, { body: r.propertyName })
    } catch { /* notifications are optional */ }
  }
}
export const REMINDER_EVENT = 'db-reminder'

/** Schedules, repeating templates and the outbox run while the app is open; one catch-up at start (handoff §8, §18, §21). */
function startJobs(svc: DatabaseService) {
  const tick = async () => {
    if (document.hidden) return
    try {
      await svc.engine.runSchedules()
      await svc.engine.dispatchOutbox()
      await fireReminders(svc)
      await pullGateway(svc)
      if (svc.state.live('template').some((t) => t.repeat)) await svc.exec([{ type: 'template.run_repeats', payload: {} }], { operationId: `repeats:${Math.floor(Date.now() / JOB_EVERY)}`, origin: 'automation' })
    } catch (e) {
      console.error('database jobs', e)
    }
  }
  window.setTimeout(() => void tick(), 3000)
  window.setInterval(() => void tick(), JOB_EVERY)
}
