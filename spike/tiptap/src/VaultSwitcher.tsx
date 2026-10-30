import { useEffect, useState } from 'react'
import { isTauri, vaultInfo } from './db'
import * as Ic from './icons'
import { t } from './i18n'

/** Card at the top of the sidebar: the workspace you are in. Clicking it opens the workspaces dialog (switch, create). */
export function WorkspaceCard({ onOpen }: { onOpen: () => void }) {
  const [name, setName] = useState('')
  useEffect(() => {
    if (!isTauri) return
    void vaultInfo().then((v) => setName(v.name))
  }, [])
  return (
    <button className="wscard" title={t('Workspaces')} onClick={onOpen}>
      <span className="wscard-ic"><Ic.Layers size={18} /></span>
      <span className="wscard-tx">
        <b dir="auto">{name || t('Personal space')}</b>
        <small>{t('Local workspace')}</small>
      </span>
      <span className="wscard-chev"><Ic.UpDown size={14} /></span>
    </button>
  )
}
