import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import { Icon } from '../ds'

/** Desktop keeps properties open; phones can unfold them without moving the writing surface down. */
export function ResponsiveProperties({ children, summary }: { children: ReactNode; summary?: string }) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  if (!narrow) return <>{children}</>
  return <details className="mobile-properties"><summary><Icon name="settings" size={15} /><span>{t('Page properties')}</span>{summary && <span className="mobile-properties-value">{summary}</span>}<Icon name="chevron-down" size={15} className="mobile-properties-chevron" /></summary>{children}</details>
}
