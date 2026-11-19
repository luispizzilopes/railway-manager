import { type ReactNode, useEffect, useId, useRef } from 'react'

import { Icon } from './Icon'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/Feedback'
import '../ui/Dialog.css'

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

// Contador para suportar modais empilhados: o rolamento só volta quando o último fecha.
let scrollLocks = 0
let previousOverflow = ''

function lockScroll() {
  if (scrollLocks++ === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
}

function unlockScroll() {
  if (--scrollLocks === 0) document.body.style.overflow = previousOverflow
}

/** Diálogo sobre o elemento nativo `<dialog>`: foco preso, fundo inerte e Esc de graça.
 *  Ao fechar, o foco volta a quem abriu. */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    lockScroll()
    const native = typeof dialog.showModal === 'function'
    if (native) dialog.showModal()
    else dialog.setAttribute('open', '')
    // Foco inicial: primeiro campo do conteúdo; sem ele, o primeiro controle ou o próprio diálogo.
    const first = dialog.querySelector<HTMLElement>('.modal-body input, .modal-body select, .modal-body textarea')
    ;(first ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus()

    const onCancel = (e: Event) => {
      e.preventDefault()
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current()
    dialog.addEventListener('cancel', onCancel)
    if (!native) window.addEventListener('keydown', onKey)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      window.removeEventListener('keydown', onKey)
      unlockScroll()
      opener?.focus?.()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      tabIndex={-1}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <span className="spacer" />
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fechar">
          <Icon name="close" />
        </Button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{message}</div>
      {error && <div className="alert alert-danger">{error}</div>}
    </Modal>
  )
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <ErrorState error={error} onRetry={onRetry} />
}
