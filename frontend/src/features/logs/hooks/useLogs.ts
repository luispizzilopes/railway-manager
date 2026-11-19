import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '@/shared/api/client'
import type { LogLine, LogsFilters, LogsResponse } from '@/shared/api/types'
import { mergeLines } from '@/features/logs/lib/utils'

/** Intervalo entre consultas ao vivo; sobe quando não chega nada novo. */
export const POLL_BASE_MS = 3000
export const POLL_MAX_MS = 12000
/** A consulta incremental recomeça um pouco antes da última linha, para não perder simultâneas. */
const OVERLAP_MS = 1000

export interface DeploymentInfo {
  id: string | null
  status: string | null
  isCurrent: boolean
}

export interface UseLogsOptions {
  instanceId: string | null
  filters: LogsFilters
  /** Acompanhar ao vivo. Fica desligado para build, deploys antigos e intervalo fechado. */
  live: boolean
}

export interface LogsState {
  lines: LogLine[]
  truncated: boolean
  deployment: DeploymentInfo | null
  loading: boolean
  /** Falha da consulta inicial (sem linhas para mostrar). */
  error: unknown
  /** Aviso de falha ao acompanhar; as linhas atuais continuam na tela. */
  notice: string | null
  paused: boolean
  setPaused: (paused: boolean) => void
  reload: () => void
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

function retryDelayMs(error: unknown, failures: number): number {
  if (error instanceof ApiError && error.status === 429) {
    const secs = Number(error.details?.retry_after_secs)
    return Math.max(Number.isFinite(secs) ? secs : 15, 3) * 1000
  }
  return Math.min(POLL_BASE_MS * 2 ** failures, 30000)
}

function noticeFor(error: unknown, delayMs: number): string {
  const wait = Math.round(delayMs / 1000)
  if (error instanceof ApiError && error.status === 429) {
    return `Limite de requisições do Railway atingido. Nova tentativa em ${wait}s.`
  }
  const reason = error instanceof Error ? error.message : 'falha desconhecida'
  return `Não foi possível atualizar os logs (${reason}). Nova tentativa em ${wait}s.`
}

export function useLogs({ instanceId, filters, live }: UseLogsOptions): LogsState {
  const [lines, setLines] = useState<LogLine[]>([])
  const [truncated, setTruncated] = useState(false)
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [reloads, setReloads] = useState(0)
  const visible = usePageVisible()
  const lastRef = useRef<string | null>(null)
  const filtersKey = JSON.stringify(filters)
  // `filters` muda de identidade a cada render do chamador; a chave estável a representa.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableFilters = useMemo(() => filters, [filtersKey])

  // Consulta inicial: recomeça a cada mudança de instância, filtros ou "recarregar".
  useEffect(() => {
    lastRef.current = null
    setLines([])
    setTruncated(false)
    setDeployment(null)
    setError(null)
    setNotice(null)
    setInitialized(false)
    if (!instanceId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .instanceLogs(instanceId, stableFilters)
      .then((res: LogsResponse) => {
        if (cancelled) return
        setLines(res.lines)
        setTruncated(res.truncated)
        setDeployment({ id: res.deployment_id, status: res.deployment_status, isCurrent: res.is_current })
        lastRef.current = res.lines.at(-1)?.timestamp ?? null
        setInitialized(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [instanceId, stableFilters, reloads])

  // Acompanhamento ao vivo: só com a aba visível, sem pausa e depois da consulta inicial.
  const active = Boolean(instanceId) && live && !paused && visible && initialized
  useEffect(() => {
    if (!active || !instanceId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = POLL_BASE_MS
    let failures = 0

    const schedule = (delay: number) => {
      timer = setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      const last = lastRef.current
      const start = last ? new Date(Date.parse(last) - OVERLAP_MS).toISOString() : stableFilters.start
      try {
        const res = await api.instanceLogs(instanceId, { ...stableFilters, start, end: undefined })
        if (cancelled) return
        failures = 0
        setNotice(null)
        if (res.lines.length > 0) {
          setLines((prev) => mergeLines(prev, res.lines))
          lastRef.current = res.lines.at(-1)?.timestamp ?? lastRef.current
          interval = POLL_BASE_MS
        } else {
          interval = Math.min(interval * 2, POLL_MAX_MS)
        }
        schedule(interval)
      } catch (e) {
        if (cancelled) return
        const delay = retryDelayMs(e, failures)
        failures += 1
        setNotice(noticeFor(e, delay))
        schedule(delay)
      }
    }
    schedule(POLL_BASE_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, instanceId, stableFilters])

  const reload = useCallback(() => setReloads((n) => n + 1), [])
  return { lines, truncated, deployment, loading, error, notice, paused, setPaused, reload }
}
