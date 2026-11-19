import type { ReactNode } from 'react'

import type { Freshness, ObservedState } from '@/shared/api/types'
import { STATE_LABEL } from '@/shared/lib/format'

import './StatusBadge.css'

// Cada estado tem forma própria além da cor, para ser reconhecível sem percepção de cor.
const SHAPES: Record<ObservedState, ReactNode> = {
  running: <path d="m3.5 8.5 3 3 6-7" />,
  sleeping: <path d="M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6Z" />,
  stopped: <rect x="4.5" y="4.5" width="7" height="7" rx="1" />,
  transitioning: <path d="M13 8a5 5 0 1 1-1.8-3.8M13 2.5v3h-3" />,
  failed: <path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.3v.1" />,
  awaiting_approval: <path d="M8 3v5l3 1.5M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" />,
  unknown: <path d="M6 6.2a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M8 12v.1" />,
}

export function StateIcon({ state }: { state: ObservedState }) {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" aria-hidden="true">
      {SHAPES[state]}
    </svg>
  )
}

/** Estado do serviço: ícone + texto + cor. O texto fica direto no elemento, junto de `data-freshness`. */
export function StatusBadge({ state, freshness }: { state: ObservedState; freshness?: Freshness }) {
  return (
    <span className={`badge badge-${state}`} data-freshness={freshness ?? 'fresh'}>
      <StateIcon state={state} />
      {STATE_LABEL[state]}
    </span>
  )
}
