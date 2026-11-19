import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyTheme, readTheme, resolveTheme, writeTheme } from './theme'

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('tema', () => {
  it('segue o sistema quando não há escolha manual', () => {
    systemPrefersDark(false)
    expect(readTheme()).toBe('system')
    expect(applyTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    systemPrefersDark(true)
    expect(applyTheme()).toBe('dark')
  })

  it('a escolha manual vence o sistema e persiste', () => {
    systemPrefersDark(false)
    writeTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(readTheme()).toBe('dark')
    expect(resolveTheme(readTheme())).toBe('dark')
    writeTheme('system')
    expect(readTheme()).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
