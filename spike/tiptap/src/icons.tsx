import type { ReactNode } from 'react'

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)
type P = { size?: number }

export const Search = (p: P) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
export const Plus = (p: P) => <I {...p}><path d="M12 5v14M5 12h14" /></I>
export const Dots = (p: P) => <I {...p}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></I>
export const Chevron = (p: P) => <I {...p}><path d="m9 6 6 6-6 6" /></I>
export const Star = ({ filled, ...p }: P & { filled?: boolean }) => <I {...p}><path fill={filled ? 'currentColor' : 'none'} d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z" /></I>
export const Trash = (p: P) => <I {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" /></I>
export const Page = (p: P) => <I {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></I>
export const Sidebar = (p: P) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></I>
export const Moon = (p: P) => <I {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></I>
export const Sun = (p: P) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>
export const Download = (p: P) => <I {...p}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></I>
export const Upload = (p: P) => <I {...p}><path d="M12 15V4m0 0L8 8m4-4 4 4M5 20h14" /></I>
export const Markdown = (p: P) => <I {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 15V9l2.5 3L12 9v6M16 9v6m0 0-2-2m2 2 2-2" /></I>
export const Link = (p: P) => <I {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></I>
export const Code = (p: P) => <I {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4" /></I>
export const Folder = (p: P) => <I {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></I>
export const Tag = (p: P) => <I {...p}><path d="M3 12V4h8l9 9-8 8z" /><circle cx="7.5" cy="8.5" r="1.2" fill="currentColor" /></I>
export const Table = (p: P) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></I>
export const Cards = (p: P) => <I {...p}><rect x="4" y="6" width="13" height="12" rx="2" /><path d="M8 3h11a2 2 0 0 1 2 2v11" /></I>
export const History = (p: P) => <I {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" /></I>
export const Print = (p: P) => <I {...p}><path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z" /></I>
export const List = (p: P) => <I {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></I>
export const Save = (p: P) => <I {...p}><path d="M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7" /></I>
export const Settings = (p: P) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>
export const Image = (p: P) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-9 9" /></I>
export const Check = (p: P) => <I {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></I>
export const Up = (p: P) => <I {...p}><path d="M12 19V5m0 0-6 6m6-6 6 6" /></I>
export const Palette = (p: P) => <I {...p}><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.6 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10.5" cy="7" r="1" fill="currentColor" /><circle cx="15" cy="7.5" r="1" fill="currentColor" /></I>
export const Type = (p: P) => <I {...p}><path d="M5 7V5h14v2M12 5v14M9 19h6" /></I>
export const Panel = (p: P) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></I>
/** Noviq mark: two offset slanted blocks (the first follows the text colour, the second is the brand violet). */
export const Logo = ({ size = 16 }: P) => (
  <svg width={size * 0.92} height={size} viewBox="0 0 196 212" aria-hidden>
    <g strokeLinejoin="round" strokeWidth="18">
      <path d="M10 42 89 96V196L10 150Z" fill="currentColor" stroke="currentColor" />
      <path d="M114 14 184 52V162L114 88Z" fill="#6c72ff" stroke="#6c72ff" />
    </g>
  </svg>
)
export const OrderedList = (p: P) => <I {...p}><path d="M10 6h11M10 12h11M10 18h11M3.5 5l1.5-1v4M3 13.5c.5-1 2.5-1 2.5.3 0 1.2-2.5 1.7-2.5 3h2.7M3 20h2.2l-1 1.2c.9-.2 1.5.3 1.5 1" /></I>
export const Checklist = (p: P) => <I {...p}><path d="m3 6 1.5 1.5L7 5M3 13l1.5 1.5L7 12M3 20l1.5 1.5L7 19M11 6h10M11 13h10M11 20h10" /></I>
export const Quote = (p: P) => <I {...p}><path d="M5 18v-5a4 4 0 0 1 4-4M13 18v-5a4 4 0 0 1 4-4M5 13h4v5H5zM13 13h4v5h-4z" /></I>
export const Undo = (p: P) => <I {...p}><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></I>
export const Redo = (p: P) => <I {...p}><path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" /></I>
export const Direction = (p: P) => <I {...p}><path d="M10 4h8M14 4v16M10 4a4.5 4.5 0 0 0 0 9M3 17h8m0 0-3-3m3 3-3 3" /></I>
export const Blocks = (p: P) => <I {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><path d="M16.5 13v7M13 16.5h7" /></I>
export const Globe = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></I>
export const Callout = (p: P) => <I {...p}><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3zM10 20.5h4" /></I>
export const Toggle = (p: P) => <I {...p}><path d="m9 7 6 5-6 5zM4 4v16" /></I>
export const Diagram = (p: P) => <I {...p}><rect x="3" y="3" width="7" height="6" rx="1.5" /><rect x="14" y="15" width="7" height="6" rx="1.5" /><path d="M6.5 9v3.5a2 2 0 0 0 2 2H14M17.5 15V9.5" /></I>
export const Divider = (p: P) => <I {...p}><path d="M4 12h16M8 7h8M8 17h8" /></I>
export const Close = (p: P) => <I {...p}><path d="m6 6 12 12M18 6 6 18" /></I>
export const At = (p: P) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" /></I>
export const Book = (p: P) => <I {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 0 4 21.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 1 1.5 1.5z" /></I>
export const AlignLeft = (p: P) => <I {...p}><path d="M4 6h16M4 10h10M4 14h16M4 18h10" /></I>
export const AlignCenter = (p: P) => <I {...p}><path d="M4 6h16M7 10h10M4 14h16M7 18h10" /></I>
export const AlignRight = (p: P) => <I {...p}><path d="M4 6h16M10 10h10M4 14h16M10 18h10" /></I>
export const Home = (p: P) => <I {...p}><path d="m3 11 9-8 9 8" /><path d="M5 10v10h5v-6h4v6h5V10" /></I>
export const Share = (p: P) => <I {...p}><path d="M12 15V4m0 0L8 8m4-4 4 4M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></I>
export const Clock = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
export const Flag = (p: P) => <I {...p}><path d="M5 21V4m0 1h11l-2 4 2 4H5" /></I>
export const Arrow = (p: P) => <I {...p}><path d="M5 12h14m-6-6 6 6-6 6" /></I>
