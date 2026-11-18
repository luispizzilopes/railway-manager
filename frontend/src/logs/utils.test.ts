import { describe, expect, it } from 'vitest'

import type { LogLine } from '../api/types'
import { MAX_LINES, formatTime, mergeLines, stripAnsi, toText } from './utils'

const line = (second: number, message: string, severity: LogLine['severity'] = null): LogLine => ({
  timestamp: `2026-11-18T10:00:${String(second).padStart(2, '0')}.000Z`,
  severity,
  message,
})

describe('utilitários de logs', () => {
  it('remove códigos de cor ANSI e mantém o texto', () => {
    expect(stripAnsi('\u001B[31;1merro\u001B[0m ao \u001B[2Kconectar')).toBe('erro ao conectar')
    expect(stripAnsi('sem códigos')).toBe('sem códigos')
  })

  it('mescla com sobreposição sem repetir linhas', () => {
    const current = [line(1, 'a'), line(2, 'b')]
    const merged = mergeLines(current, [line(2, 'b'), line(3, 'c')])
    expect(merged.map((l) => l.message)).toEqual(['a', 'b', 'c'])
  })

  it('devolve a mesma referência quando nada é novo', () => {
    const current = [line(1, 'a'), line(2, 'b')]
    expect(mergeLines(current, [line(2, 'b')])).toBe(current)
    expect(mergeLines(current, [])).toBe(current)
  })

  it('conta linhas idênticas e simultâneas em vez de descartá-las', () => {
    const current = [line(1, 'tick'), line(1, 'tick')]
    const merged = mergeLines(current, [line(1, 'tick'), line(1, 'tick'), line(1, 'tick'), line(2, 'x')])
    expect(merged.map((l) => l.message)).toEqual(['tick', 'tick', 'tick', 'x'])
  })

  it('mantém só as linhas mais recentes acima do teto', () => {
    const many = Array.from({ length: MAX_LINES }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 10, 18, 10, 0, 0, i)).toISOString(),
      severity: null,
      message: `m${i}`,
    }))
    const merged = mergeLines(many, [line(30, 'novo')])
    expect(merged).toHaveLength(MAX_LINES)
    expect(merged.at(-1)?.message).toBe('novo')
    expect(merged[0].message).toBe('m1')
  })

  it('gera o arquivo com horário, severidade e mensagem por linha', () => {
    const text = toText([line(1, '\u001B[32mok\u001B[0m', 'info'), line(2, 'sem nível')])
    expect(text).toBe('2026-11-18T10:00:01.000Z [INFO] ok\n2026-11-18T10:00:02.000Z [-] sem nível')
  })

  it('formata o horário local e preserva valores ilegíveis', () => {
    expect(formatTime('2026-11-18T10:00:01.123Z')).toMatch(/^\d{2}:\d{2}:\d{2}\.123$/)
    expect(formatTime('lixo')).toBe('lixo')
  })
})
