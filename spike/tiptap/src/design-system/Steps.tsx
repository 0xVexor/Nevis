import { cx } from './dir'

/** Where a person is in a short, ordered flow. `label` is already translated ("Step 2 of 3"). */
export function Steps({ count, current, label, className }: { count: number; current: number; label: string; className?: string }) {
  return (
    <ol className={cx('ds-steps', className)} aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={i < current ? 'is-done' : i === current ? 'is-current' : undefined} aria-current={i === current ? 'step' : undefined} />
      ))}
    </ol>
  )
}
