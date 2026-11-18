// Tema da interface: segue o sistema por padrão; a escolha manual fica neste navegador.
// O script inline do index.html aplica a mesma regra antes da primeira pintura.

import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'rm:theme'
const DARK = '(prefers-color-scheme: dark)'
const listeners = new Set<() => void>()

export function readTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(pref: ThemePreference): Theme {
  if (pref !== 'system') return pref
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK).matches ? 'dark' : 'light'
}

export function applyTheme(pref: ThemePreference = readTheme()): Theme {
  const theme = resolveTheme(pref)
  document.documentElement.dataset.theme = theme
  return theme
}

export function writeTheme(pref: ThemePreference) {
  try {
    if (pref === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, pref)
  } catch {
    // sem persistência: vale só nesta visita
  }
  applyTheme(pref)
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(DARK) : null
  const onSystem = () => {
    if (readTheme() === 'system') applyTheme('system')
    onChange()
  }
  query?.addEventListener('change', onSystem)
  return () => {
    listeners.delete(onChange)
    query?.removeEventListener('change', onSystem)
  }
}

export function useTheme(): { preference: ThemePreference; theme: Theme; setPreference: (p: ThemePreference) => void } {
  const preference = useSyncExternalStore(subscribe, readTheme, () => 'system' as const)
  return { preference, theme: resolveTheme(preference), setPreference: writeTheme }
}
