import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../i18n'

/** Desktop keeps properties open; phones can unfold them without moving the writing surface down. */
export function ResponsiveProperties({ children }: { children: ReactNode }) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  if (!narrow) return <>{children}</>
  return <details className="mobile-properties"><summary>{t('Page properties')}</summary>{children}</details>
}
