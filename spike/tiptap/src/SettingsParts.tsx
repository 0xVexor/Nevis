import type { ReactNode } from 'react'

/** A titled group on a settings tab. */
export const Card = ({ icon, title, hint, children }: { icon?: ReactNode; title: ReactNode; hint?: string; children: ReactNode }) => (
  <section className="sx-card">
    <header className="sx-card-head">
      {icon && <span className="sx-ic">{icon}</span>}
      <div>
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </div>
    </header>
    <div className="sx-card-body">{children}</div>
  </section>
)

/** `wide` rows put the control under the text (swatches, grids); the others keep it beside it. */
export const Row = ({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) => (
  <div className={'sx-row' + (wide ? ' wide' : '')}>
    <div className="sx-tx">
      <b>{label}</b>
      {hint && <small>{hint}</small>}
    </div>
    <div className="sx-ctl">{children}</div>
  </div>
)
