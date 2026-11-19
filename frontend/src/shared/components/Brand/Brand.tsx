/** Nome do produto, só em texto. */
export function Brand({ className = 'side-brand' }: { className?: string }) {
  return (
    <div className={className}>
      <span className="brand-name">
        Railway<span>Manager</span>
      </span>
    </div>
  )
}
