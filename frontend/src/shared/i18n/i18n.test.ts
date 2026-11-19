import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n, setLanguage } from '@/shared/i18n'
import { detectLanguage } from './languages'

afterEach(() => vi.unstubAllGlobals())

function browserIn(...languages: string[]) {
  vi.stubGlobal('navigator', { languages, language: languages[0] })
}

describe('detectLanguage', () => {
  it('usa a escolha salva', () => {
    window.localStorage.setItem('rm:lang', 'en')
    browserIn('pt-BR')
    expect(detectLanguage()).toBe('en')
  })

  it('segue o navegador em inglês', () => {
    browserIn('en-US')
    expect(detectLanguage()).toBe('en')
  })

  it('cai em pt-BR para idiomas não suportados', () => {
    browserIn('fr-FR')
    expect(detectLanguage()).toBe('pt-BR')
  })
})

describe('setLanguage', () => {
  it('troca o idioma, persiste e atualiza <html lang>', async () => {
    await setLanguage('en')
    expect(i18n.language).toBe('en')
    expect(window.localStorage.getItem('rm:lang')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
