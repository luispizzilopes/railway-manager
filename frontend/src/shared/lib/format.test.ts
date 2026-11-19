import { afterEach, describe, expect, it } from 'vitest'

import { setLanguage } from '@/shared/i18n'
import { KIND_LABEL, STATE_LABEL, formatDays, relativeTime } from './format'

afterEach(() => setLanguage('pt-BR'))

const now = Date.parse('2026-11-18T12:00:00Z')
const fiveMinAgo = new Date(now - 5 * 60_000).toISOString()

describe('format', () => {
  it('pt-BR', () => {
    expect(relativeTime(fiveMinAgo, now)).toBe('há 5 min')
    expect(STATE_LABEL.running).toBe('Ativo')
    expect(formatDays([0, 1, 2, 3, 4])).toBe('Seg–Sex')
  })

  it('en', async () => {
    await setLanguage('en')
    expect(relativeTime(fiveMinAgo, now)).toBe('5 min ago')
    expect(STATE_LABEL.running).toBe('Running')
    expect(KIND_LABEL.stop).toBe('Stop')
    expect(formatDays([0, 1, 2, 3, 4])).toBe('Mon–Fri')
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
  })
})
