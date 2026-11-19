import { describe, expect, it } from 'vitest'

import { describeWhen, formatSpan, parseDuration, parseWhen } from './time'

const SP = 'America/Sao_Paulo'
// 14:48 em São Paulo (UTC−3).
const NOW = new Date('2026-11-17T17:48:00Z')

const at = (input: Parameters<typeof parseWhen>[0], now = NOW, tz = SP) => parseWhen(input, now, tz).at.toISOString()

describe('--at / --in', () => {
  it('horário hoje ou amanhã', () => {
    expect(at({ at: '18:00' })).toBe('2026-11-17T21:00:00.000Z')
    expect(at({ at: '07:00' }, new Date('2026-11-17T22:00:00Z'))).toBe('2026-11-18T10:00:00.000Z')
    expect(at({ at: '18h' })).toBe('2026-11-17T21:00:00.000Z')
    expect(at({ at: '18h30' })).toBe('2026-11-17T21:30:00.000Z')
  })

  it('datas explícitas e relativas', () => {
    expect(at({ at: '2026-11-20 07:00' })).toBe('2026-11-20T10:00:00.000Z')
    expect(at({ at: '2026-11-20T07:00' })).toBe('2026-11-20T10:00:00.000Z')
    expect(at({ at: 'amanhã 07:00' })).toBe('2026-11-18T10:00:00.000Z')
    expect(at({ at: 'hoje 23:59' })).toBe('2026-11-18T02:59:00.000Z')
    expect(at({ at: '20/11 07:00' })).toBe('2026-11-20T10:00:00.000Z')
    expect(at({ at: '18:00', tz: 'UTC' })).toBe('2026-11-17T18:00:00.000Z')
  })

  it('durações', () => {
    expect(at({ in: '2h' })).toBe('2026-11-17T19:48:00.000Z')
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('1h30m')).toBe(90 * 60_000)
    expect(parseDuration('1h30')).toBe(90 * 60_000)
    expect(parseDuration('1d')).toBe(24 * 3600_000)
    for (const bad of ['', '45', '0m', 'x', '2 h']) expect(() => parseDuration(bad), bad).toThrow()
  })

  it('erros', () => {
    expect(() => parseWhen({ at: '25:00' }, NOW, SP)).toThrow(/horário inválido/)
    expect(() => parseWhen({ at: '2026-02-30 07:00' }, NOW, SP)).toThrow(/data inválida/)
    expect(() => parseWhen({ at: 'ontem 07:00' }, NOW, SP)).toThrow(/data inválida/)
    expect(() => parseWhen({ at: '07:00', in: '1h' }, NOW, SP)).toThrow(/não os dois/)
    expect(() => parseWhen({ at: '07:00', tz: 'Marte/Base' }, NOW, SP)).toThrow(/fuso inválido/)
  })

  it('horário de verão em Nova York', () => {
    const ny = 'America/New_York'
    const before = new Date('2026-03-07T12:00:00Z')
    // 08/03/2026 02:30 não existe → primeiro instante válido (03:00 EDT = 07:00Z).
    expect(at({ at: '2026-03-08 02:30' }, before, ny)).toBe('2026-03-08T07:00:00.000Z')
    // 01/11/2026 01:30 é ambíguo → primeira ocorrência (EDT, 05:30Z).
    expect(at({ at: '2026-11-01 01:30' }, new Date('2026-10-31T12:00:00Z'), ny)).toBe('2026-11-01T05:30:00.000Z')
    expect(at({ at: '2026-07-01 09:00' }, before, ny)).toBe('2026-07-01T13:00:00.000Z')
  })

  it('descrição relativa', () => {
    expect(describeWhen(new Date('2026-11-17T21:00:00Z'), SP, NOW)).toBe('hoje 18:00 — em 3h12m')
    expect(describeWhen(new Date('2026-11-18T10:00:00Z'), SP, NOW)).toBe('amanhã 07:00 — em 16h12m')
    expect(formatSpan(45 * 60_000)).toBe('45m')
    expect(formatSpan(50 * 3600_000)).toBe('2d 2h')
  })
})
