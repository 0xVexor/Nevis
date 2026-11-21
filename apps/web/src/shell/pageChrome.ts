import { createContext } from 'react'
/** What the shell tells the open page: reader mode makes it read-only; the element the page fills with its outline lives in the page drawer. */
export const PageChrome = createContext<{ reader: boolean }>({ reader: false })
export const OUTLINE_SLOT = 'outline-slot'
