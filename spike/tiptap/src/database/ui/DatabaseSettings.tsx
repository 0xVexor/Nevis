// Settings → Database: workspace calendar defaults, the optional map tile provider and the status of the connected services.
// Nothing here ships a key or a default provider: a map needs a tile URL the person chooses, the gateway a URL the person runs.
import { useState } from 'react'
import { setPreference, removePreference } from '../../preferenceEvents'
import { GatewayClient, GATEWAY_TOKEN_KEY, GATEWAY_URL_KEY, type GatewayStatus } from '../gateway/client'
import { Button, Dropdown, Facts, Field, FormField, PreferenceGroup, PreferenceRow } from '../../design-system'
import { t } from '../../i18n'
import { ErrorLine } from './common'
import { MAP_KEY, loadTileConfig } from './MapView'

export const WEEK_KEY = 'not.db.weekStart'
export const GATEWAY_KEY = GATEWAY_URL_KEY
const CHECK_TEXT: Record<GatewayStatus, string> = {
  ready: 'Connected',
  needs_setup: 'Needs setup',
  offline: 'The gateway cannot be reached',
  unauthorized: 'The gateway refused the token',
  unsupported: 'Not supported by this gateway',
  error: 'The gateway answered with an error',
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string) => {
  try {
    v ? setPreference(k, v) : removePreference(k)
  } catch {
    /* settings are a convenience */
  }
}

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
  const changed = () => setSaved(false)
  const save = () => {
    write(WEEK_KEY, week)
    write(MAP_KEY, tpl && !tplBad ? JSON.stringify({ template: tpl, attribution: attr }) : '')
    write(GATEWAY_KEY, gw && !gwBad ? gw : '')
    write(GATEWAY_TOKEN_KEY, token)
    setSaved(true)
  }
  return (
    <div className="dv-settings">
      <PreferenceGroup title={t('Calendar')}>
        <PreferenceRow label={t('First day of the week')} hint={t('Used by calendars, week filters and week charts. Reload the app after changing it.')}>
          <Dropdown label={t('First day of the week')} value={week} options={DAYS.map((d, n) => ({ value: String(n), label: d }))} onChange={(v) => (setWeek(v), changed())} />
        </PreferenceRow>
      </PreferenceGroup>
      <PreferenceGroup title={t('Maps')}>
        <FormField label={t('Map tile URL')} hint={t('An https address with {z}, {x} and {y}. No provider or key is built in; choose one whose terms you accept.')}>
          <Field ltr value={tpl} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" aria-invalid={tplBad} onChange={(e) => (setTpl(e.target.value), changed())} />
        </FormField>
        {tplBad && <ErrorLine>{t('Use an HTTPS URL containing {z}, {x} and {y}.')}</ErrorLine>}
        <FormField label={t('Map attribution')}>
          <Field value={attr} onChange={(e) => (setAttr(e.target.value), changed())} />
        </FormField>
      </PreferenceGroup>
      <PreferenceGroup title={t('Gateway')}>
        <FormField label={t('Gateway address')} hint={t('The Nevis gateway publishes forms and runs scheduled messages. Without it, everything stays on this device.')}>
          <Field ltr value={gw} placeholder="https://gateway.example.com" aria-invalid={gwBad} onChange={(e) => (setGw(e.target.value), changed())} />
        </FormField>
        {gwBad && <ErrorLine>{t('Use HTTPS, or an HTTP localhost address.')}</ErrorLine>}
        <FormField label={t('Gateway owner token')} hint={t('Kept on this device only, outside your notes. Created when you set up the gateway.')}>
          <Field ltr type="password" autoComplete="off" value={token} onChange={(e) => (setToken(e.target.value), changed())} />
        </FormField>
      </PreferenceGroup>
      <div className="dv-settings-acts">
        <Button variant="primary" disabled={tplBad || gwBad} onClick={save}>
          {t('Save changes')}
        </Button>
        <Button
          disabled={!gw || !token || gwBad}
          onClick={() => {
            setCheck('checking')
            void new GatewayClient({ url: gw, token }).status().then(setCheck)
          }}
        >
          {t('Check connection')}
        </Button>
        {saved && (
          <span role="status" className="dv-hint">
            {t('Saved')}
          </span>
        )}
        {check && (
          <span role="status" className="dv-hint">
            {check === 'checking' ? t('Checking…') : t(CHECK_TEXT[check])}
          </span>
        )}
      </div>
      <PreferenceGroup title={t('Status')}>
        <Facts
          items={[
            [t('On this device'), t('Working')],
            [t('Gateway (public forms, outbound messages)'), gw && !gwBad ? t('Address saved; not verified from here') : t('Not set up')],
            [t('Connected providers'), t('Not connected')],
          ]}
        />
      </PreferenceGroup>
    </div>
  )
}
