import { Button, Notice } from '../design-system'
import { t } from '../i18n'
import { ago } from '../ui'
import { deviceLabel } from './labels'
import type { ConflictMarker } from './types'

const TITLES: Record<ConflictMarker['kind'], string> = {
  edit: 'This page was edited on two devices',
  'editor-race': 'This page was edited on two devices',
  merged: 'This page was edited on two devices',
  restore: 'This page was restored on one device and edited on another',
  'deleted-here': 'This page was deleted here and edited on another device',
  'deleted-there': 'This page was deleted on another device and edited here',
}

/** Shown on top of a page that has unresolved conflicts; names the newest one. Pure props: the page decides what Review and Keep current do. */
export function ConflictBanner({ markers, onReview, onKeepCurrent }: { markers: ConflictMarker[]; onReview: (marker: ConflictMarker) => void; onKeepCurrent: (marker: ConflictMarker) => void }) {
  if (markers.length === 0) return null
  const marker = markers.reduce((a, b) => (b.detectedAt > a.detectedAt ? b : a))
  const earlier = markers.length - 1
  return (
    <Notice
      tone="warn"
      title={t(TITLES[marker.kind])}
      className="cf-banner"
      action={
        <>
          <Button variant="primary" size="sm" onClick={() => onReview(marker)}>
            {t('Review')}
          </Button>
          <Button size="sm" onClick={() => onKeepCurrent(marker)}>
            {t('Keep current')}
          </Button>
        </>
      }
    >
      {t('{local} ({localTime}) and {remote} ({remoteTime}).', {
        local: deviceLabel(marker, 'local'),
        localTime: ago(marker.local.savedAt),
        remote: deviceLabel(marker, 'remote'),
        remoteTime: ago(marker.remote.savedAt),
      })}
      {earlier > 0 && ' ' + t('Plus {n} earlier conflicts.', { n: earlier })}
    </Notice>
  )
}
