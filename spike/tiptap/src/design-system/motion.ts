import { useReducedMotion } from 'motion/react'

/** Motion values for the design system. Keep them in step with --ds-fast, --ds-base and --ds-ease in tokens.css. */
export const MOTION = {
  fast: 0.12,
  base: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
  spring: { type: 'spring', stiffness: 460, damping: 36, mass: 0.8 } as const,
}

const INSTANT = { duration: 0 } as const
const FULL = { reduced: false, transition: { duration: MOTION.base, ease: MOTION.ease }, spring: MOTION.spring } as const
const NONE = { reduced: true, transition: INSTANT, spring: INSTANT } as const

/** True when the system or the app's own Reduce motion setting asks for no animation. For event handlers; components use useUIMotion. */
export const prefersReducedMotion = () => document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches

/** Transitions that honour the system setting and the app's Reduce motion preference. The returned objects are shared constants. */
export function useUIMotion() {
  const system = useReducedMotion()
  return system || document.documentElement.dataset.motion === 'reduce' ? NONE : FULL
}
