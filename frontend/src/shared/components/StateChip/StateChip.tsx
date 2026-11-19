import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  const when = observedAt ? relativeTime(observedAt) : t('freshness.noReading')
  const title = observedAt ? t('freshness.lastRead', { when: formatDateTime(observedAt) }) : undefined
  if (freshness === 'unavailable') {
    return (
      <span className="freshness freshness-unavailable" title={error ?? title}>
        {t('freshness.unavailable', { when })}
      </span>
    )
  }
  if (freshness === 'stale') {
    return (
      <span className="freshness freshness-stale" title={title}>
        {t('freshness.stale', { when })}
      </span>
    )
  }
  return (
    <span className="freshness" title={title}>
      {t('freshness.read', { when })}
    </span>
  )
}
