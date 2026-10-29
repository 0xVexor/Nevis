import { setPreference, removePreference } from '../../preferenceEvents'
// Settings → Database: workspace calendar defaults, the optional map tile provider and the status of the connected services.
// Nothing here ships a key or a default provider: a map needs a tile URL the person chooses, the gateway a URL the person runs.
import { useState, type ReactNode } from 'react'
import { GatewayClient, GATEWAY_TOKEN_KEY, GATEWAY_URL_KEY, type GatewayStatus } from '../gateway/client'
import { t } from '../../i18n'
import { Select } from '../../ui'
import * as Ic from '../../icons'
import { MAP_KEY, loadTileConfig } from './MapView'

export const WEEK_KEY = 'not.db.weekStart'
export const GATEWAY_KEY = GATEWAY_URL_KEY
const CHECK_TEXT: Record<GatewayStatus, string> = { ready: 'Connected', needs_setup: 'Needs setup', offline: 'The gateway cannot be reached', unauthorized: 'The gateway refused the token', unsupported: 'Not supported by this gateway', error: 'The gateway answered with an error' }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const read = (k: string) => { try { return localStorage.getItem(k) ?? '' } catch { return '' } }
const write = (k: string, v: string) => { try { v ? setPreference(k, v) : removePreference(k) } catch { /* settings are a convenience */ } }

export function DatabaseSettings() {
  const tiles = loadTileConfig()
  const [week, setWeek] = useState(read(WEEK_KEY) || '6')
  const [tpl, setTpl] = useState(tiles?.template ?? '')
  const [attr, setAttr] = useState(tiles?.attribution ?? '')
  const [gw, setGw] = useState(read(GATEWAY_KEY))
  const [token, setToken] = useState(read(GATEWAY_TOKEN_KEY))
  const [saved, setSaved] = useState(false)
  const [check, setCheck] = useState<GatewayStatus | 'checking' | null>(null)
  const tplBad = !!tpl && !/^https:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(tpl)
  const gwBad = !!gw && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(gw)
  const save = () => {
    write(WEEK_KEY, week)
    write(MAP_KEY, tpl && !tplBad ? JSON.stringify({ template: tpl, attribution: attr }) : '')
    write(GATEWAY_KEY, gw && !gwBad ? gw : '')
    write(GATEWAY_TOKEN_KEY, token)
    setSaved(true)
  }
  return (
    <div className="db-settings">
      <Card icon={<Ic.Clock />} title={t('Calendar')}>
        <Row label={t('First day of the week')} hint={t('Used by calendars, week filters and week charts. Reload the app after changing it.')}>
          <Select value={week} options={DAYS.map((d, n) => ({ value: String(n), label: t(d) }))} onChange={(v) => (setWeek(v), setSaved(false))} />
        </Row>
      </Card>
      <Card icon={<Ic.Link />} title={t('Maps')}>
        <Row label={t('Map tile URL')} hint={t('An https address with {z}, {x} and {y}. No provider or key is built in; choose one whose terms you accept.')} wide>
          <input className="sx-input" dir="ltr" value={tpl} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" aria-invalid={tplBad} onChange={(e) => (setTpl(e.target.value), setSaved(false))} />
        </Row>
        <Row label={t('Map attribution')} wide>
          <input className="sx-input" dir="auto" value={attr} onChange={(e) => (setAttr(e.target.value), setSaved(false))} />
        </Row>
      </Card>
      <Card icon={<Ic.Share />} title={t('Gateway')}>
        <Row label={t('Gateway address')} hint={t('The Nevis gateway publishes forms and runs scheduled messages. Without it, everything stays on this device.')} wide>
          <input className="sx-input" dir="ltr" value={gw} placeholder="https://gateway.example.com" aria-invalid={gwBad} onChange={(e) => (setGw(e.target.value), setSaved(false))} />
        </Row>
        <Row label={t('Gateway owner token')} hint={t('Kept on this device only, outside your notes and never synced. Created when you set up the gateway.')} wide>
          <input className="sx-input" type="password" dir="ltr" autoComplete="off" value={token} onChange={(e) => (setToken(e.target.value), setSaved(false))} />
        </Row>
      </Card>
      <div className="sx-actions">
        <button type="button" className="primary" disabled={tplBad || gwBad} onClick={save}>{t('Save')}</button>
        <button type="button" className="ghost-btn" disabled={!gw || !token || gwBad} onClick={() => { setCheck('checking'); void new GatewayClient({ url: gw, token }).status().then(setCheck) }}>{t('Check connection')}</button>
        {saved && <span role="status" className="sx-note ok">{t('Saved')}</span>}
        {check && <span role="status" className="sx-note">{check === 'checking' ? t('Checking…') : t(CHECK_TEXT[check])}</span>}
      </div>
      <Card icon={<Ic.Check />} title={t('Status')}>
        <ul className="db-status">
          <li><b>{t('On this device')}</b><span>{t('Working')}</span></li>
          <li><b>{t('Sync between devices')}</b><span>{t('Not checked: needs a connected vault')}</span></li>
          <li><b>{t('Gateway (public forms, outbound messages)')}</b><span>{gw && !gwBad ? t('Address saved; not verified from here') : t('Not set up')}</span></li>
          <li><b>{t('Connected providers')}</b><span>{t('Not connected')}</span></li>
        </ul>
      </Card>
    </div>
  )
}

const Card = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <section className="sx-card">
    <header className="sx-card-head"><span className="sx-ic">{icon}</span><div><h3>{title}</h3></div></header>
    <div className="sx-card-body">{children}</div>
  </section>
)

const Row = ({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) => (
  <div className={'sx-row' + (wide ? ' wide' : '')}>
    <div className="sx-tx"><b>{label}</b>{hint && <small>{hint}</small>}</div>
    <div className="sx-ctl">{children}</div>
  </div>
)
