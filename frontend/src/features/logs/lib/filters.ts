// Estado dos filtros de logs e sua conversão de/para a URL e a API.

import type { LogKind, LogSeverity, LogsFilters } from '@/shared/api/types'

export const SEVERITIES: LogSeverity[] = ['error', 'warn', 'info', 'debug']
export const LIMITS = [100, 200, 500, 1000]
export const DEFAULT_LIMIT = 200

export interface LogFilterState {
  type: LogKind
  /** Vazio = deploy atual. */
  deployment: string
  /** `datetime-local` (horário do navegador); vazio = sem limite. */
  start: string
  end: string
  severity: LogSeverity[]
  q: string
  limit: number
}

export const DEFAULT_FILTERS: LogFilterState = {
  type: 'runtime',
  deployment: '',
  start: '',
  end: '',
  severity: [],
  q: '',
  limit: DEFAULT_LIMIT,
}

/** Só grava na URL o que difere do padrão, para links curtos. */
export function filtersToParams(filters: LogFilterState, params = new URLSearchParams()): URLSearchParams {
  const set = (key: string, value: string, fallback = '') => {
    if (value !== fallback) params.set(key, value)
    else params.delete(key)
  }
  set('type', filters.type, DEFAULT_FILTERS.type)
  set('deployment', filters.deployment)
  set('start', filters.start)
  set('end', filters.end)
  set('severity', filters.severity.join(','))
  set('q', filters.q)
  set('limit', String(filters.limit), String(DEFAULT_LIMIT))
  return params
}

export function paramsToFilters(params: URLSearchParams): LogFilterState {
  const type = params.get('type') === 'build' ? 'build' : 'runtime'
  const severity = (params.get('severity') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is LogSeverity => (SEVERITIES as string[]).includes(s))
  const limit = Number(params.get('limit'))
  return {
    type,
    deployment: params.get('deployment') ?? '',
    start: params.get('start') ?? '',
    end: params.get('end') ?? '',
    severity,
    q: params.get('q') ?? '',
    limit: LIMITS.includes(limit) ? limit : DEFAULT_LIMIT,
  }
}

function toIso(local: string): string | undefined {
  if (!local) return undefined
  const date = new Date(local)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function toApiFilters(state: LogFilterState): LogsFilters {
  return {
    type: state.type,
    deployment_id: state.deployment || undefined,
    start: toIso(state.start),
    end: toIso(state.end),
    severity: state.severity,
    q: state.q.trim() || undefined,
    limit: state.limit,
  }
}
