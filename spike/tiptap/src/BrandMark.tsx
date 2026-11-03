import { BRAND_PATHS } from './brand/mark'

/** The product mark. Its colour follows the surface that owns it. */
export function BrandMark({ size, className = '' }: { size?: number; className?: string }) {
  return <svg className={('ds-icon brand-mark ' + className).trim()} width={size ?? 24} height={size ?? 24} style={size === undefined ? undefined : { inlineSize: size, blockSize: size }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {BRAND_PATHS.map(path => <path key={path} d={path} />)}
  </svg>
}
