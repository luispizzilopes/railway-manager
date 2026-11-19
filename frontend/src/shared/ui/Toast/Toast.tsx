import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import { useTranslation } from 'react-i18next'

import { Icon } from '@/shared/components/Icon/Icon'
import './Toast.css'

type Tone = 'success' | 'error' | 'info'
type Item = { id: number; tone: Tone; message: string }

export type Toasts = {
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const NOOP: Toasts = { success: () => undefined, error: () => undefined, info: () => undefined }
const ToastContext = createContext<Toasts>(NOOP)

/** Tempo até o aviso sumir sozinho; erros ficam mais para dar tempo de ler. */
export const TOAST_MS: Record<Tone, number> = { success: 4000, info: 4000, error: 8000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const seq = useRef(0)
  const { t } = useTranslation()

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = ++seq.current
      setItems((all) => [...all.slice(-3), { id, tone, message }])
      setTimeout(() => dismiss(id), TOAST_MS[tone])
    },
    [dismiss],
  )
  const api = useMemo<Toasts>(
    () => ({ success: (m) => push('success', m), error: (m) => push('error', m), info: (m) => push('info', m) }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label={t('ui.toasts')} aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
            <span>{item.message}</span>
            <button type="button" className="toast-close" aria-label={t('ui.dismiss')} onClick={() => dismiss(item.id)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): Toasts {
  return useContext(ToastContext)
}
