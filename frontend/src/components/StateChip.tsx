import type { Freshness, ObservedState } from '../api/types'
import { STATE_LABEL, formatDateTime, relativeTime } from '../format'

export function StateChip({ state, freshness }: { state: ObservedState; freshness?: Freshness }) {
  return (
    <span className={`chip chip-${state}`} data-freshness={freshness ?? 'fresh'}>
      {STATE_LABEL[state]}
    </span>
  )
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
