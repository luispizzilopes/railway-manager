import i18n from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'

import { DEFAULT_LANGUAGE, LANGUAGE_KEY, type Language, detectLanguage } from './languages'
import { resources } from './resources'

export { LANGUAGES, type Language } from './languages'

export const NAMESPACES = Object.keys(resources['pt-BR']) as (keyof (typeof resources)['pt-BR'])[]

function applyDocumentLanguage(language: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

/** Inicializa o i18n (uma vez). Os testes chamam com `pt-BR` para manter os textos atuais. */
export function initI18n(language: Language = detectLanguage()) {
  if (i18n.isInitialized) {
    void i18n.changeLanguage(language)
  } else {
    void i18n.use(initReactI18next).init({
      resources,
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      ns: NAMESPACES,
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
    })
  }
  applyDocumentLanguage(language)
  return i18n
}

/** Troca o idioma, grava a escolha neste navegador e atualiza `<html lang>`. */
export async function setLanguage(language: Language) {
  await i18n.changeLanguage(language)
  applyDocumentLanguage(language)
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language)
  } catch {
    // sem armazenamento: vale só para esta sessão
  }
}

export function currentLanguage(): Language {
  return i18n.language === 'en' ? 'en' : 'pt-BR'
}

/** Idioma ativo (reativo) para componentes que formatam datas/números. */
export function useLanguage(): Language {
  const { i18n: instance } = useTranslation()
  return instance.language === 'en' ? 'en' : 'pt-BR'
}

export { i18n }
