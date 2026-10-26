/** Product wordmark. The full stop always follows the workspace accent. */
export function Brand({ className = '' }: { className?: string }) {
  return <span className={'brand ' + className} dir="ltr">Nevis<span className="brand-dot">.</span></span>
}
