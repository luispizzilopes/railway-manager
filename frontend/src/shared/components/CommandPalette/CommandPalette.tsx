import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'

import { Icon, type IconName } from '@/shared/components/Icon/Icon'

export type PaletteItem = { id: string; label: string; hint?: string; icon: IconName; run: () => void }

/** Paleta de comandos (Ctrl+K): busca por parte do nome, setas para escolher, Enter para executar. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items
  }, [items, query])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    const native = typeof dialog.showModal === 'function'
    if (native) dialog.showModal()
    else dialog.setAttribute('open', '')
    const onCancel = (e: Event) => {
      e.preventDefault()
      onCloseRef.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      opener?.focus?.()
    }
  }, [])

  function choose(item: PaletteItem | undefined) {
    if (!item) return
    onClose()
    item.run()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => (matches.length === 0 ? 0 : (i + step + matches.length) % matches.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(matches[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Paleta de comandos"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <input
        className="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={matches[index] ? `palette-${matches[index].id}` : undefined}
        aria-label="Buscar tela ou ação"
        placeholder="Ir para…"
        autoComplete="off"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      {matches.length === 0 ? (
        <div className="palette-empty">Nada encontrado para “{query}”.</div>
      ) : (
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Resultados">
          {matches.map((item, i) => (
            // oxlint-disable-next-line click-events-have-key-events -- o teclado age pelo campo de busca (combobox)
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === index}
              className="palette-item"
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.hint && <span className="hint">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  )
}
