/**
 * Nevis design system — file kinds.
 * Maps a file name or MIME type to one of a small set of kinds, each with an icon (from iconData.ts) and a colour.
 * Pure data and one function, so scripts and tests can read it. <FileIcon> in fileIcons.tsx draws it.
 */
export type FileKind =
  | 'image' | 'audio' | 'video' | 'pdf' | 'doc' | 'sheet' | 'slides' | 'text' | 'code' | 'data'
  | 'archive' | 'font' | 'design' | 'book' | 'model' | 'key' | 'app' | 'folder' | 'page' | 'board' | 'todo' | 'database' | 'file'

export interface FileKindInfo {
  label: string
  icon: string
  color: string
}

export const FILE_KINDS: Record<FileKind, FileKindInfo> = {
  image: { label: 'Image', icon: 'file-image', color: '#3b82d6' },
  audio: { label: 'Audio', icon: 'file-audio', color: '#c98a14' },
  video: { label: 'Video', icon: 'file-video', color: '#8b5cf6' },
  pdf: { label: 'PDF', icon: 'file-pdf', color: '#d1456f' },
  doc: { label: 'Document', icon: 'file-text', color: '#3b6fd4' },
  sheet: { label: 'Spreadsheet', icon: 'file-spreadsheet', color: '#2e9e6a' },
  slides: { label: 'Presentation', icon: 'file-slides', color: '#d9692c' },
  text: { label: 'Text', icon: 'file-text', color: '#64748b' },
  code: { label: 'Code', icon: 'file-code', color: '#0f8f83' },
  data: { label: 'Data', icon: 'file-data', color: '#0aa0c2' },
  archive: { label: 'Archive', icon: 'file-archive', color: '#7b8492' },
  font: { label: 'Font', icon: 'file-font', color: '#a855a0' },
  design: { label: 'Design', icon: 'file-design', color: '#e0457b' },
  book: { label: 'Book', icon: 'file-book', color: '#b9770e' },
  model: { label: '3D model', icon: 'file-3d', color: '#5b6ee0' },
  key: { label: 'Key', icon: 'file-key', color: '#a07a1c' },
  app: { label: 'Application', icon: 'file-app', color: '#475569' },
  folder: { label: 'Folder', icon: 'folder-open', color: '#0f8f83' },
  page: { label: 'Page', icon: 'file-text', color: '#7c6ae6' },
  board: { label: 'Board', icon: 'pencil', color: '#2e9e6a' },
  todo: { label: 'To-do list', icon: 'checklist', color: '#d9692c' },
  database: { label: 'Database', icon: 'database', color: '#3b82d6' },
  file: { label: 'File', icon: 'file', color: '#7b8492' },
}

const EXT: Record<FileKind, string> = {
  image: 'png jpg jpeg gif webp avif svg bmp ico heic heif tif tiff raw',
  audio: 'mp3 wav ogg oga flac m4a aac opus aiff mid midi',
  video: 'mp4 mov mkv webm avi m4v wmv flv mpg mpeg',
  pdf: 'pdf',
  doc: 'doc docx odt rtf pages',
  sheet: 'xls xlsx ods numbers csv tsv',
  slides: 'ppt pptx odp key keynote',
  text: 'txt md markdown log rst tex',
  code: 'js mjs cjs ts tsx jsx py rs go java kt swift c h cpp hpp cs rb php sh bash zsh ps1 sql html css scss less vue svelte lua dart r',
  data: 'json xml yaml yml toml ini env ndjson parquet sqlite db',
  archive: 'zip rar 7z tar gz tgz bz2 xz iso dmg',
  font: 'ttf otf woff woff2 eot',
  design: 'fig sketch psd ai xd indd afdesign excalidraw drawio',
  book: 'epub mobi azw azw3 djvu cbz',
  model: 'obj stl fbx glb gltf blend 3ds step',
  key: 'pem crt cer p12 pfx asc gpg pub',
  app: 'exe msi apk app deb rpm appimage bat cmd',
  folder: '', page: '', board: '', todo: '', database: '', file: '',
}

const BY_EXT = new Map<string, FileKind>()
for (const [kind, list] of Object.entries(EXT) as [FileKind, string][]) for (const e of list.split(' ').filter(Boolean)) if (!BY_EXT.has(e)) BY_EXT.set(e, kind)

export const extensionOf = (name = '') => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

/** The kind of a file: by extension first, then by MIME type, else a plain file. */
export function fileKind(name = '', mime = ''): FileKind {
  const byExt = BY_EXT.get(extensionOf(name))
  if (byExt) return byExt
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('text/')) return m === 'text/csv' ? 'sheet' : 'text'
  if (m.includes('zip') || m.includes('compressed') || m.includes('tar')) return 'archive'
  if (m.includes('json') || m.includes('xml')) return 'data'
  if (m.includes('font')) return 'font'
  return 'file'
}

/** Extensions listed for the live reference, grouped by kind. */
export const FILE_EXTENSIONS: Record<FileKind, string[]> = Object.fromEntries((Object.entries(EXT) as [FileKind, string][]).map(([k, v]) => [k, v.split(' ').filter(Boolean)])) as Record<FileKind, string[]>
