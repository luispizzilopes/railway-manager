import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react'

import './Field.css'

type ControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }

/** Rótulo, dica e erro ligados ao controle por ARIA; o controle recebe as props prontas. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children: (props: ControlProps) => ReactNode
}) {
  const id = useId()
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': describedBy || undefined, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`input${className ? ` ${className}` : ''}`} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`input textarea${className ? ` ${className}` : ''}`} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={`select${className ? ` ${className}` : ''}`} />
}

export function Checkbox({ label, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label className="check">
      <input {...rest} type="checkbox" />
      <span>{label}</span>
    </label>
  )
}

export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: ReactNode
  name: string
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="radio-group">
      <legend>{legend}</legend>
      <div className="radio-row">
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
