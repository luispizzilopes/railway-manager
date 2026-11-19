import type { ReactNode } from 'react'

import { Button } from '@/shared/ui/Button/Button'
import './Feedback.css'

export function Skeleton({ lines = 3, label = 'Carregando…' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, retrying }: { error: unknown; onRetry?: () => void; retrying?: boolean }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="alert alert-danger" role="alert">
      <span className="alert-text">{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry} loading={retrying}>
          Tentar novamente
        </Button>
      )}
    </div>
  )
}
