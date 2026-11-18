import type { ButtonHTMLAttributes } from 'react'

import './Button.css'

export type ButtonVariant = 'secondary' | 'primary' | 'danger' | 'ghost'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  /** Ação em andamento: desabilita o botão e impede envio duplicado. */
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', loading = false, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'secondary' && `btn-${variant}`, size === 'sm' && 'btn-sm', loading && 'is-loading', className]
  return (
    <button
      {...rest}
      type={type}
      className={classes.filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}
