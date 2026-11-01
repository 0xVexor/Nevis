import type { CSSProperties } from 'react'

/** Inline style that sets CSS custom properties (`--name`), which React's `CSSProperties` does not list. */
export const cssVars = (vars: Record<`--${string}`, string | number>) => vars as CSSProperties
