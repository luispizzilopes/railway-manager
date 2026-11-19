// `--at` / `--in` / `--tz` → instante UTC, e descrição relativa ("hoje 18:00 — em 3h12m").

import { currentLanguage } from '@/shared/i18n'
import { ct } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'

const MINUTE = 60_000

function parts(t: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, number> = {}
  for (const p of fmt.formatToParts(new Date(t))) if (p.type !== 'literal') map[p.type] = Number(p.value)
  return { year: map.year, month: map.month, day: map.day, hour: map.hour, minute: map.minute, second: map.second }
}

/** Deslocamento (ms) do fuso no instante `t`: local − UTC. */
function offset(t: number, timeZone: string): number {
  const p = parts(t, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(t / 1000) * 1000
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export interface LocalDate {
  year: number
  month: number
  day: number
}

/** Data local de `t` no fuso. */
export function localDate(t: number, timeZone: string): LocalDate {
  const p = parts(t, timeZone)
  return { year: p.year, month: p.month, day: p.day }
}

function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/**
 * Horário local → UTC. Horário inexistente (início do horário de verão) vira o primeiro
 * instante válido; horário ambíguo (fim do horário de verão), a primeira ocorrência.
 */
export function zonedToUtc(d: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(d.year, d.month - 1, d.day, hour, minute)
  const before = offset(guess - 12 * 3600_000, timeZone)
  const after = offset(guess + 12 * 3600_000, timeZone)
  const wanted = (t: number) => {
    const p = parts(t, timeZone)
    return p.year === d.year && p.month === d.month && p.day === d.day && p.hour === hour && p.minute === minute
  }
  const candidates = [...new Set([guess - before, guess - after])].filter(wanted)
  if (candidates.length) return new Date(Math.min(...candidates))
  // Lacuna: procura o instante da transição.
  let lo = Math.min(guess - before, guess - after)
  let hi = Math.max(guess - before, guess - after)
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE
    if (offset(mid, timeZone) === after) hi = mid
    else lo = mid
  }
  return new Date(hi)
}

/** `30m`, `2h`, `1h30m`, `1h30`, `1d`, `1d2h` → milissegundos. */
export function parseDuration(text: string): number {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/i.exec(text.trim())
  if (!m || text.trim() === '' || (m[3] !== undefined && !m[1] && !m[2] && !/m/i.test(text))) {
    throw new CommandError(ct('m.time.durationInvalid', { text }))
  }
  const [, d, h, min] = m
  const ms = ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * MINUTE
  if (ms <= 0) throw new CommandError(ct('m.time.durationZero', { text }))
  return ms
}

function time(text: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})(?::(\d{2})|h(\d{2})?)$/i.exec(text.trim())
  const hour = m ? Number(m[1]) : NaN
  const minute = m ? Number(m[2] ?? m[3] ?? 0) : NaN
  if (!m || hour > 23 || minute > 59) throw new CommandError(ct('m.time.timeInvalid', { text }))
  return { hour, minute }
}

function date(text: string, today: LocalDate): LocalDate | null {
  const lower = text.toLowerCase()
  if (lower === 'hoje' || lower === 'today') return today
  if (['amanhã', 'amanha', 'tomorrow'].includes(lower)) return addDays(today, 1)
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text)
  if (m) return { year: Number(m[3] ?? today.year), month: Number(m[2]), day: Number(m[1]) }
  return null
}

export interface When {
  at: Date
  timeZone: string
}

/** Resolve `--at` ou `--in` a partir de `now`, no fuso `timeZone`. */
export function parseWhen(
  input: { at?: string; in?: string; tz?: string },
  now: Date,
  defaultTimeZone: string,
): When {
  const timeZone = input.tz?.trim() || defaultTimeZone
  if (!validTimeZone(timeZone)) throw new CommandError(ct('m.time.zoneInvalid', { tz: timeZone }))
  if (input.at && input.in) throw new CommandError(ct('m.time.atOrIn'))
  if (input.in) return { at: new Date(now.getTime() + parseDuration(input.in)), timeZone }
  if (!input.at) throw new CommandError(ct('m.time.needAtOrIn'))

  const text = input.at.trim().replace('T', ' ')
  const today = localDate(now.getTime(), timeZone)
  const pieces = text.split(/\s+/)
  let day: LocalDate | null
  let clock: string
  if (pieces.length === 1) {
    day = null
    clock = pieces[0]
  } else if (pieces.length === 2) {
    day = date(pieces[0], today)
    clock = pieces[1]
    if (!day) throw new CommandError(ct('m.time.dateInvalid', { text: pieces[0] }))
  } else {
    throw new CommandError(ct('m.time.instantInvalid', { text: input.at }))
  }
  const { hour, minute } = time(clock)
  if (day) {
    const check = new Date(Date.UTC(day.year, day.month - 1, day.day))
    if (check.getUTCMonth() + 1 !== day.month || check.getUTCDate() !== day.day) {
      throw new CommandError(ct('m.time.dateOnlyInvalid', { text: pieces[0] }))
    }
    return { at: zonedToUtc(day, hour, minute, timeZone), timeZone }
  }
  // Só o horário: hoje, ou amanhã se já passou.
  let at = zonedToUtc(today, hour, minute, timeZone)
  if (at.getTime() <= now.getTime()) at = zonedToUtc(addDays(today, 1), hour, minute, timeZone)
  return { at, timeZone }
}

/** "3h12m", "45m", "2d 4h". */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`
  return `${m}m`
}

/** "hoje 18:00 — em 3h12m" no fuso informado. */
export function describeWhen(at: Date, timeZone: string, now: Date): string {
  const target = localDate(at.getTime(), timeZone)
  const today = localDate(now.getTime(), timeZone)
  const same = (a: LocalDate, b: LocalDate) => a.year === b.year && a.month === b.month && a.day === b.day
  const locale = currentLanguage()
  const hm = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(at)
  let day: string
  if (same(target, today)) day = ct('m.time.today')
  else if (same(target, addDays(today, 1))) day = ct('m.time.tomorrow')
  else {
    day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: '2-digit', month: '2-digit' }).format(at)
  }
  const delta = at.getTime() - now.getTime()
  const rel = delta >= 0 ? ct('m.time.in', { span: formatSpan(delta) }) : ct('m.time.ago', { span: formatSpan(-delta) })
  return `${day} ${hm} — ${rel}`
}
