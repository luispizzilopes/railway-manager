// Utilitários dos logs: texto seguro, mesclagem sem duplicatas e arquivo para baixar.

import type { LogLine } from '../api/types'

/** Teto de linhas mantidas no navegador; as mais antigas saem primeiro. */
export const MAX_LINES = 5000

// Sequências CSI (cores, cursor) e OSC do ANSI.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

const lineKey = (l: LogLine) => `${l.timestamp}\u0000${l.message}`

/**
 * Junta um lote recebido ao que já está na tela. O lote costuma começar um pouco antes
 * da última linha (sobreposição), então só entram as ocorrências de (horário, mensagem)
 * que ainda não existem; linhas idênticas e simultâneas são contadas, não descartadas.
 */
export function mergeLines(existing: LogLine[], incoming: LogLine[], max = MAX_LINES): LogLine[] {
  if (incoming.length === 0) return existing
  const first = incoming.reduce((min, l) => (l.timestamp < min ? l.timestamp : min), incoming[0].timestamp)
  const seen = new Map<string, number>()
  for (let i = existing.length - 1; i >= 0 && existing[i].timestamp >= first; i--) {
    const key = lineKey(existing[i])
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const fresh: LogLine[] = []
  for (const line of incoming) {
    const key = lineKey(line)
    const left = seen.get(key) ?? 0
    if (left > 0) seen.set(key, left - 1)
    else fresh.push(line)
  }
  if (fresh.length === 0) return existing
  const merged = [...existing, ...fresh].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/** Texto de um trecho: uma linha por registro, com horário, severidade e mensagem. */
export function toText(lines: LogLine[]): string {
  return lines
    .map((l) => `${l.timestamp} [${(l.severity ?? '-').toUpperCase()}] ${stripAnsi(l.message)}`)
    .join('\n')
}

/** Horário local da linha, com milissegundos. */
export function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
