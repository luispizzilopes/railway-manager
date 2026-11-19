import { useSyncExternalStore } from 'react'

// Celular: user agent móvel ou tela estreita. Nele só vale a interface gráfica,
// sem modo CLI e sem console.
const QUERY = '(max-width: 720px)'

export function isMobile(): boolean {
  if (/Android|iPhone|iPod|Mobi/i.test(window.navigator.userAgent)) return true
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobile, () => false)
}
