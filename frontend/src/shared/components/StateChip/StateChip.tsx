import type { Freshness, ObservedState } from '@/shared/api/types'
import { formatDateTime, relativeTime } from '@/shared/lib/format'
import { StatusBadge } from '@/shared/ui/StatusBadge/StatusBadge'

export function StateChip({ state, freshness }: { state: ObservedState; freshness?: Freshness }) {
  return <StatusBadge state={state} freshness={freshness} />
}

/** Horário da leitura com o frescor explícito em texto (não só cor). */
export function FreshnessNote({
  freshness,
  observedAt,
  error,
}: {
  freshness: Freshness
  observedAt: string | null
  error?: string | null
}) {
  const when = observedAt ? relativeTime(observedAt) : 'sem leitura'
  const title = observedAt ? `Última leitura: ${formatDateTime(observedAt)}` : undefined
  if (freshness === 'unavailable') {
    return (
      <span className="freshness freshness-unavailable" title={error ?? title}>
        Indisponível · última leitura {when}
      </span>
    )
  }
  if (freshness === 'stale') {
    return (
      <span className="freshness freshness-stale" title={title}>
        Desatualizado · {when}
      </span>
    )
  }
  return (
    <span className="freshness" title={title}>
      Lido {when}
    </span>
  )
}
