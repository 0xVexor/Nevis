import { Icon } from './icons'
import { FILE_KINDS, extensionOf, fileKind, type FileKind } from './fileKinds'
import { t } from '../i18n'

/**
 * <FileIcon name="report.pdf" /> or <FileIcon kind="folder" />.
 * A tinted tile with the kind's icon. `ext` adds the extension under it (lowercase, no shouting). Sizes: 24 (list), 32, 44, 64 (grid).
 */
export function FileIcon({ name, mime, kind, size = 32, ext = false, className }: { name?: string; mime?: string; kind?: FileKind; size?: number; ext?: boolean; className?: string }) {
  const k = kind ?? fileKind(name, mime)
  const info = FILE_KINDS[k]
  const e = ext ? extensionOf(name) : ''
  return (
    <span className={'ds-file-icon' + (className ? ' ' + className : '')} style={{ ['--c' as string]: info.color, ['--s' as string]: size + 'px' }} role="img" aria-label={t(info.label)}>
      <Icon name={info.icon} size={Math.round(size * 0.52)} />
      {e && <em>{e.slice(0, 5)}</em>}
    </span>
  )
}
