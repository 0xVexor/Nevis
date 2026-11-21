import { createContext } from 'react'
/** The element a screen may fill the Pages panel with (the old app's Tasks screen puts its list of sources there). null = not available. */
export const PanelHost = createContext<HTMLElement | null>(null)
