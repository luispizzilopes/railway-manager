// Rótulos e formatação para a interface, no idioma ativo.

import type { ItemResult, ObservedState, OperationStatus, PowerKind, RunStatus, SyncStatus } from '@/shared/api/types'
import { currentLanguage, i18n } from '@/shared/i18n'

/** Mapa de rótulos resolvido na leitura, para acompanhar o idioma ativo. */
function labels<K extends string>(keys: readonly K[], resolve: (key: K) => string): Record<K, string> {
  const map = {} as Record<K, string>
  for (const key of keys) Object.defineProperty(map, key, { enumerable: true, get: () => resolve(key) })
  return map
}

export const STATE_LABEL = labels<ObservedState>(
  ['running', 'stopped', 'sleeping', 'transitioning', 'failed', 'awaiting_approval', 'unknown'],
  (k) => i18n.t(`state.${k}`),
)

export const RESULT_LABEL = labels<ItemResult>(
  ['pending', 'running', 'verifying', 'succeeded', 'failed', 'skipped', 'timed_out', 'interrupted'],
  (k) => i18n.t(`result.${k}`),
)

export const STATUS_LABEL = labels<OperationStatus>(
  ['pending', 'running', 'succeeded', 'partially_failed', 'failed'],
  (k) => i18n.t(`opStatus.${k}`),
)

export const KIND_LABEL = labels<PowerKind>(['start', 'stop'], (k) => i18n.t(`kind.${k}`))

export const SYNC_LABEL = labels<SyncStatus>(['never', 'ok', 'failed', 'not_found'], (k) => i18n.t(`sync.${k}`))

export const RUN_LABEL = labels<RunStatus>(
  ['pending', 'executed', 'late', 'skipped', 'missed', 'failed'],
  (k) => i18n.t(`run.${k}`),
)

/** Locale do `Intl` para o idioma ativo. */
const locale = () => currentLanguage()

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—'
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return i18n.t('time.never')
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (seconds < 10) return i18n.t('time.now')
  if (seconds < 60) return i18n.t('time.secondsAgo', { count: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return i18n.t('time.minutesAgo', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return i18n.t('time.hoursAgo', { count: hours })
  return formatDateTime(iso)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)} s` : i18n.t('time.minutes', { m: Math.floor(s / 60), s: Math.round(s % 60) })
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** Dias da semana abreviados (segunda a domingo) no idioma ativo. */
export const DAY_LABEL: readonly string[] = new Proxy([] as string[], {
  get: (_target, prop) => {
    const days = i18n.t('day.short', { returnObjects: true }) as unknown as string[]
    const value = Reflect.get(days, prop)
    return typeof value === 'function' ? value.bind(days) : value
  },
})

/** "Seg–Sex", "Todos os dias", "Seg, Qua, Sex". */
export function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return i18n.t('day.everyDay')
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  if (contiguous && sorted.length > 2) return `${DAY_LABEL[sorted[0]]}–${DAY_LABEL[sorted[sorted.length - 1]]}`
  return sorted.map((d) => DAY_LABEL[d]).join(', ')
}

/** Data e hora no fuso informado (ex.: "seg., 17/11 07:00"). */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}
