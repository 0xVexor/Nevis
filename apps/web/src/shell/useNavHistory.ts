// Back and forward in the top bar, as the old app had them: its own stack of the places visited, so each button knows when it is at an end.
// (The hash router still owns the address; this only remembers the order.)
import { useCallback, useEffect, useRef, useState } from 'react'

export function useNavHistory(here: string, go: (hash: string) => void) {
  const stack = useRef<string[]>([here])
  const pos = useRef(0)
  const jumping = useRef(false)
  const [, redraw] = useState(0)
  useEffect(() => {
    if (jumping.current) { jumping.current = false; return }
    if (stack.current[pos.current] === here) return
    stack.current = [...stack.current.slice(0, pos.current + 1), here].slice(-100)
    pos.current = stack.current.length - 1
    redraw(n => n + 1)
  }, [here])
  const step = useCallback((d: -1 | 1) => {
    const to = pos.current + d
    if (to < 0 || to >= stack.current.length) return
    pos.current = to; jumping.current = true; go(stack.current[to]!); redraw(n => n + 1)
  }, [go])
  return { canBack: pos.current > 0, canForward: pos.current < stack.current.length - 1, back: () => step(-1), forward: () => step(1) }
}
