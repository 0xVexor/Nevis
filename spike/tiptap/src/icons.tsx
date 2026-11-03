import type { ReactNode } from 'react'
import { Icon } from './design-system/icons'

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)
type P = { size?: number }

export const Columns = ({ count = 2, ...p }: P & { count?: number }) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    {count === 2 && <path d="M12 4v16" />}
    {count === 3 && <path d="M9 4v16M15 4v16" />}
  </I>
)

export const Search = (p: P) => <Icon name="search" size={p.size ?? 16} />
export const Plus = (p: P) => <Icon name="plus" size={p.size ?? 16} />
export const Dots = (p: P) => (
  <I {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </I>
)
export const Chevron = (p: P) => (
  <I {...p}>
    <path d="m9 6 6 6-6 6" />
  </I>
)
export const Star = ({ filled, ...p }: P & { filled?: boolean }) => (
  <I {...p}>
    <path fill={filled ? 'currentColor' : 'none'} d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z" />
  </I>
)
export const Trash = (p: P) => <Icon name="trash" size={p.size ?? 16} />
export const Page = (p: P) => <Icon name="file" size={p.size ?? 16} />
export const Sidebar = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </I>
)
export const Moon = (p: P) => <Icon name="moon" size={p.size ?? 16} />
export const Sun = (p: P) => <Icon name="sun" size={p.size ?? 16} />
export const Download = (p: P) => <Icon name="download" size={p.size ?? 16} />
export const Upload = (p: P) => <Icon name="upload" size={p.size ?? 16} />
export const Markdown = (p: P) => (
  <I {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M7 15V9l2.5 3L12 9v6M16 9v6m0 0-2-2m2 2 2-2" />
  </I>
)
export const Link = (p: P) => <Icon name="link" size={p.size ?? 16} />
export const Code = (p: P) => <Icon name="code" size={p.size ?? 16} />
export const Folder = (p: P) => <Icon name="folder" size={p.size ?? 16} />
export const Tag = (p: P) => <Icon name="tag" size={p.size ?? 16} />
export const Table = (p: P) => <Icon name="table" size={p.size ?? 16} />
export const Cards = (p: P) => <Icon name="cards" size={p.size ?? 16} />
export const History = (p: P) => <Icon name="history" size={p.size ?? 16} />
export const Print = (p: P) => <Icon name="printer" size={p.size ?? 16} />
export const List = (p: P) => (
  <I {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </I>
)
export const Save = (p: P) => <Icon name="save" size={p.size ?? 16} />
export const Settings = (p: P) => <Icon name="settings" size={p.size ?? 16} />
export const Keyboard = (p: P) => <Icon name="keyboard" size={p.size ?? 16} />
export const Key = (p: P) => <Icon name="key" size={p.size ?? 16} />
export const Image = (p: P) => <Icon name="image" size={p.size ?? 16} />
export const Check = (p: P) => <Icon name="check" size={p.size ?? 16} />
export const Up = (p: P) => (
  <I {...p}>
    <path d="M12 19V5m0 0-6 6m6-6 6 6" />
  </I>
)
export const Palette = (p: P) => <Icon name="palette" size={p.size ?? 16} />
export const Type = (p: P) => <Icon name="type" size={p.size ?? 16} />
export const Panel = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </I>
)
export const OrderedList = (p: P) => (
  <I {...p}>
    <path d="M10 6h11M10 12h11M10 18h11M3.5 5l1.5-1v4M3 13.5c.5-1 2.5-1 2.5.3 0 1.2-2.5 1.7-2.5 3h2.7M3 20h2.2l-1 1.2c.9-.2 1.5.3 1.5 1" />
  </I>
)
export const Checklist = (p: P) => <Icon name="checklist" size={p.size ?? 16} />
export const Quote = (p: P) => <Icon name="quote" size={p.size ?? 16} />
export const Undo = (p: P) => <Icon name="undo" size={p.size ?? 16} />
export const Redo = (p: P) => <Icon name="redo" size={p.size ?? 16} />
export const Direction = (p: P) => (
  <I {...p}>
    <path d="M10 4h8M14 4v16M10 4a4.5 4.5 0 0 0 0 9M3 17h8m0 0-3-3m3 3-3 3" />
  </I>
)
export const Blocks = (p: P) => (
  <I {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <path d="M16.5 13v7M13 16.5h7" />
  </I>
)
export const Globe = (p: P) => <Icon name="globe" size={p.size ?? 16} />
export const Callout = (p: P) => (
  <I {...p}>
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3zM10 20.5h4" />
  </I>
)
export const Toggle = (p: P) => (
  <I {...p}>
    <path d="m9 7 6 5-6 5zM4 4v16" />
  </I>
)
export const Diagram = (p: P) => (
  <I {...p}>
    <rect x="3" y="3" width="7" height="6" rx="1.5" />
    <rect x="14" y="15" width="7" height="6" rx="1.5" />
    <path d="M6.5 9v3.5a2 2 0 0 0 2 2H14M17.5 15V9.5" />
  </I>
)
export const Divider = (p: P) => (
  <I {...p}>
    <path d="M4 12h16M8 7h8M8 17h8" />
  </I>
)
export const Close = (p: P) => <Icon name="x" size={p.size ?? 16} />
export const At = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" />
  </I>
)
export const Book = (p: P) => <Icon name="book" size={p.size ?? 16} />
export const AlignLeft = (p: P) => (
  <I {...p}>
    <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />
  </I>
)
export const AlignCenter = (p: P) => (
  <I {...p}>
    <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />
  </I>
)
export const AlignRight = (p: P) => (
  <I {...p}>
    <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />
  </I>
)
export const Home = (p: P) => <Icon name="home" size={p.size ?? 16} />
export const Share = (p: P) => <Icon name="share" size={p.size ?? 16} />
export const Clock = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </I>
)
export const Flag = (p: P) => <Icon name="flag" size={p.size ?? 16} />
export const Arrow = (p: P) => (
  <I {...p}>
    <path d="M5 12h14m-6-6 6 6-6 6" />
  </I>
)
export const Copy = (p: P) => <Icon name="copy" size={p.size ?? 16} />
export const Cut = (p: P) => <Icon name="scissors" size={p.size ?? 16} />
export const Paste = (p: P) => (
  <I {...p}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4h6v3H9zM9 12h6M9 16h4" />
  </I>
)
export const SelectAll = (p: P) => (
  <I {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M9 12h6" />
  </I>
)
export const Bold = (p: P) => <Icon name="bold" size={p.size ?? 16} />
export const Italic = (p: P) => <Icon name="italic" size={p.size ?? 16} />
export const Strike = (p: P) => (
  <I {...p}>
    <path d="M5 12h14M16 7c-.5-1.8-2-3-4.3-3C9.3 4 8 5.3 8 7c0 1.3.800 2.1 2 2.6M8 17c.6 1.8 2.2 3 4.5 3 2.5 0 4-1.3 4-3 0-.700-.200-1.2-.600-1.7" />
  </I>
)
export const Eye = (p: P) => <Icon name="eye" size={p.size ?? 16} />
export const Open = (p: P) => (
  <I {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </I>
)
export const Pencil = (p: P) => <Icon name="pencil" size={p.size ?? 16} />
export const Clipboard = (p: P) => <Icon name="clipboard" size={p.size ?? 16} />
export const Archive = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </I>
)
export const Pdf = (p: P) => (
  <I {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M8.5 16v-3h1.3a1 1 0 0 1 0 2H8.5M13 16v-3h1a1.5 1.5 0 0 1 0 3z" />
  </I>
)
export const Folders = (p: P) => (
  <I {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v4M10 13h4" />
  </I>
)
export const Cloud = (p: P) => <Icon name="cloud" size={p.size ?? 16} />
export const Reader = (p: P) => (
  <I {...p}>
    <path d="M2 5.5C4.5 4 8 4 12 6.5c4-2.5 7.5-2.5 10-1V19c-2.5-1.5-6-1.5-10 1-4-2.5-7.5-2.5-10-1z" />
    <path d="M12 6.5V20M5.5 9.2c1.6-.3 3-.2 4.3.4M5.5 12.8c1.6-.3 3-.2 4.3.4M18.5 9.2c-1.6-.3-3-.2-4.3.4" />
  </I>
)
export const Layers = (p: P) => <Icon name="layers" size={p.size ?? 16} />
export const UpDown = (p: P) => (
  <I {...p}>
    <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />
  </I>
)
export const Info = (p: P) => <Icon name="info" size={p.size ?? 16} />
export const RowAbove = (p: P) => (
  <I {...p}>
    <rect x="3" y="11" width="18" height="9" rx="2" />
    <path d="M12 3v5M9.5 5.5h5" />
  </I>
)
export const RowBelow = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="9" rx="2" />
    <path d="M12 16v5M9.5 18.5h5" />
  </I>
)
export const RowDelete = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9.5 12.5h5" />
  </I>
)
export const ColLeft = (p: P) => (
  <I {...p}>
    <rect x="11" y="4" width="10" height="16" rx="2" />
    <path d="M3 12h5M5.5 9.5v5" />
  </I>
)
export const ColRight = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="10" height="16" rx="2" />
    <path d="M16 12h5M18.5 9.5v5" />
  </I>
)
export const ColDelete = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16M10.5 12h3" />
  </I>
)
export const CellMerge = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v4M12 16v4M8 12h8M8 12l2-2M8 12l2 2M16 12l-2-2M16 12l-2 2" />
  </I>
)
export const CellSplit = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16M5 12h3M16 12h3" />
  </I>
)
export const TableDelete = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </I>
)
export const HeadRow = (p: P) => (
  <I {...p}>
    <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4H3z" fill="currentColor" fillOpacity="0.28" />
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M12 10v10" />
  </I>
)
export const HeadCol = (p: P) => (
  <I {...p}>
    <path d="M3 6a2 2 0 0 1 2-2h4v16H5a2 2 0 0 1-2-2z" fill="currentColor" fillOpacity="0.28" />
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M9 12h12" />
  </I>
)
export const Reset = (p: P) => (
  <I {...p}>
    <path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5" />
  </I>
)
export const Shrink = (p: P) => (
  <I {...p}>
    <path d="M20 9h-5V4M4 15h5v5M15 9l5-5M9 15l-5 5" />
  </I>
)
export const Enlarge = (p: P) => (
  <I {...p}>
    <path d="M15 4h5v5M9 20H4v-5M20 4l-7 7M4 20l7-7" />
  </I>
)
