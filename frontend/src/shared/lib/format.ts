// Rótulos e formatação para a interface (pt-BR).

import type { ItemResult, ObservedState, OperationStatus, PowerKind, RunStatus, SyncStatus } from '@/shared/api/types'

export const STATE_LABEL: Record<ObservedState, string> = {
  running: 'Ativo',
  stopped: 'Desligado',
  sleeping: 'Dormindo',
  transitioning: 'Em transição',
  failed: 'Com falha',
  awaiting_approval: 'Aguardando aprovação',
  unknown: 'Desconhecido',
}

export const RESULT_LABEL: Record<ItemResult, string> = {
  pending: 'Pendente',
  running: 'Executando',
  verifying: 'Verificando',
  succeeded: 'Concluído',
  failed: 'Falhou',
  skipped: 'Ignorado',
  timed_out: 'Sem confirmação',
  interrupted: 'Interrompido',
}

export const STATUS_LABEL: Record<OperationStatus, string> = {
  pending: 'Pendente',
  running: 'Em andamento',
  succeeded: 'Concluída',
  partially_failed: 'Parcialmente falha',
  failed: 'Falhou',
}

export const KIND_LABEL: Record<PowerKind, string> = { start: 'Iniciar', stop: 'Desligar' }

export const SYNC_LABEL: Record<SyncStatus, string> = {
  never: 'Nunca sincronizado',
  ok: 'Sincronizado',
  failed: 'Falha na sincronização',
  not_found: 'Não encontrado no Railway',
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—'
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'nunca'
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (seconds < 10) return 'agora'
  if (seconds < 60) return `há ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  return formatDateTime(iso)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export const DAY_LABEL = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']

/** "Seg–Sex", "Todos os dias", "Seg, Qua, Sex". */
export function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return 'Todos os dias'
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  if (contiguous && sorted.length > 2) return `${DAY_LABEL[sorted[0]]}–${DAY_LABEL[sorted[sorted.length - 1]]}`
  return sorted.map((d) => DAY_LABEL[d]).join(', ')
}

export const RUN_LABEL: Record<RunStatus, string> = {
  pending: 'Em execução',
  executed: 'Executado',
  late: 'Executado com atraso',
  skipped: 'Nada a fazer',
  missed: 'Perdido',
  failed: 'Falhou',
}

/** Data e hora no fuso informado (ex.: "seg., 17/11 07:00"). */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}
