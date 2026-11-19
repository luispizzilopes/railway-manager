// Idiomas suportados e escolha inicial: preferência salva → idioma do navegador → pt-BR.

export const LANGUAGES = ['pt-BR', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = 'pt-BR'
export const LANGUAGE_KEY = 'rm:lang'

function match(tag: string | null | undefined): Language | null {
  const base = tag?.toLowerCase().split('-')[0]
  if (base === 'pt') return 'pt-BR'
  if (base === 'en') return 'en'
  return null
}

export function detectLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_KEY)
    if (saved === 'pt-BR' || saved === 'en') return saved
  } catch {
    // armazenamento indisponível: segue para o idioma do navegador
  }
  const candidates = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]
  for (const tag of candidates) {
    const found = match(tag)
    if (found) return found
  }
  return DEFAULT_LANGUAGE
}
