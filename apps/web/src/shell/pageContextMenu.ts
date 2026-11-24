import { createContext } from 'react'

export const PageContextMenu = createContext<((id: string, anchor: DOMRect) => void) | null>(null)
