// Visão do console: saída (role="log") e linha de comando com histórico, busca e Tab.

import { useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { api } from '@/shared/api/client'
import type { Dashboard, ScheduleView, ScheduledAction } from '@/shared/api/types'
import { PAGES } from './commands/misc'
import { complete } from './complete'
import { useConsole } from './ConsoleProvider'
import { BlockView } from './output'

function useCompletionData() {
  const queryClient = useQueryClient()
  return () => {
    const schedules = queryClient.getQueryData<{ schedules: ScheduleView[] }>(['schedules'])
    const actions = queryClient.getQueriesData<{ items: ScheduledAction[] }>({ queryKey: ['scheduled-actions'] })
    const dashboard = queryClient.getQueryData<Dashboard>(['dashboard'])
    return {
      dashboard,
      schedules: schedules?.schedules.map((s) => s.schedule.name),
      actions: actions.flatMap(([, data]) => data?.items.map((a) => a.id.slice(0, 8)) ?? []),
      operations: dashboard?.recent_operations.map((o) => o.operation.id.slice(0, 8)),
      pages: Object.keys(PAGES),
    }
  }
}

export function Console({
  variant = 'page',
  onClose,
  prefetch = true,
  welcome,
}: {
  variant?: 'page' | 'panel' | 'cli'
  onClose?: () => void
  /** Carrega os dados do autocompletar (só com sessão válida). */
  prefetch?: boolean
  /** Texto mostrado enquanto a saída está vazia. */
  welcome?: ReactNode
}) {
  const c = useConsole()
  const queryClient = useQueryClient()
  const completionData = useCompletionData()
  const [cursor, setCursor] = useState<number | null>(null)
  const [search, setSearch] = useState<{ term: string; from: number } | null>(null)
  const [options, setOptions] = useState<string[]>([])
  const [answer, setAnswer] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!prefetch) return
    // Dados para o autocompletar (falhas aqui não importam).
    void queryClient.prefetchQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })
    void queryClient.prefetchQuery({ queryKey: ['schedules'], queryFn: () => api.schedules() })
    void queryClient.prefetchQuery({ queryKey: ['scheduled-actions', 'pending'], queryFn: () => api.scheduledActions('pending') })
  }, [prefetch, queryClient])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [c.blocks, c.prompt])

  useEffect(() => {
    if (c.prompt) inputRef.current?.focus()
  }, [c.prompt])

  function submit() {
    if (c.prompt) {
      c.answer(answer)
      setAnswer('')
      return
    }
    const line = c.input
    c.setInput('')
    setCursor(null)
    setSearch(null)
    setOptions([])
    void c.run(line)
  }

  function browse(delta: -1 | 1) {
    const h = c.history
    if (h.length === 0) return
    const next = cursor === null ? (delta === -1 ? h.length - 1 : null) : cursor + delta
    if (next === null || next >= h.length) {
      setCursor(null)
      c.setInput('')
      return
    }
    const clamped = Math.max(0, next)
    setCursor(clamped)
    c.setInput(h[clamped])
  }

  /** Ctrl+R: cada toque busca uma entrada mais antiga que contém o termo. */
  function reverseSearch() {
    const term = search?.term ?? c.input
    const from = search ? search.from - 1 : c.history.length - 1
    for (let i = from; i >= 0; i--) {
      if (c.history[i].toLowerCase().includes(term.toLowerCase())) {
        setSearch({ term, from: i })
        c.setInput(c.history[i])
        return
      }
    }
    setSearch({ term, from: -1 })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const ctrl = e.ctrlKey || e.metaKey
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (ctrl && e.key.toLowerCase() === 'c') {
      const el = e.currentTarget
      const selected = el.selectionStart !== el.selectionEnd
      if (!selected && (c.running || c.prompt)) {
        e.preventDefault()
        setAnswer('')
        c.interrupt()
      } else if (!selected && c.input) {
        e.preventDefault()
        c.setInput('')
        setSearch(null)
      }
    } else if (ctrl && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      c.clear()
    } else if (c.prompt) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setAnswer('')
        c.answer(null)
      }
    } else if (ctrl && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      reverseSearch()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      browse(-1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      browse(1)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const data = { ...completionData(), aliases: Object.keys(c.aliases) }
      const result = complete(c.input, c.commands, data)
      c.setInput(result.line)
      setOptions(result.options)
    } else if (e.key === 'Escape') {
      if (search) setSearch(null)
      else onClose?.()
    }
  }

  /** Clique em qualquer parte do console vai para a linha de comando, exceto em
   *  controles (ex.: copiar ID) ou quando há texto selecionado para copiar. */
  function focusInput(e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return
    if (window.getSelection()?.toString()) return
    inputRef.current?.focus()
  }

  const prompt = c.prompt
  return (
    // oxlint-disable-next-line click-events-have-key-events, no-static-element-interactions -- o teclado já tem a própria linha de comando
    <div className={`console console-${variant}`} onClick={focusInput}>
      <div className="console-log" ref={logRef} role="log" aria-live="polite" aria-label="Saída do console">
        {c.blocks.length === 0 && welcome}
        {c.blocks.length === 0 && !welcome && (
          <div className="con-text con-tone-muted">
            Console do Railway Manager. Digite <strong>help</strong> para ver os comandos — por exemplo{' '}
            <code>stop all --dry-run</code> ou <code>start loja@production</code>.
          </div>
        )}
        {c.blocks.map(({ id, block }) => (
          <BlockView key={id} block={block} />
        ))}
      </div>
      {options.length > 0 && !prompt && (
        <div className="console-options" data-testid="completion-options">
          {options.join('   ')}
        </div>
      )}
      <div className={`console-line${prompt ? ' console-line-prompt' : ''}`}>
        <label htmlFor="console-input" className="con-prompt-label">
          {prompt ? (
            <>
              {prompt.question} {prompt.secret || prompt.plain ? '' : prompt.word ? `[${prompt.word}]` : '[s/N]'}
            </>
          ) : search ? (
            `busca (${search.term || '…'})${search.from < 0 ? ' sem resultado' : ''} ›`
          ) : (
            <span aria-hidden>›</span>
          )}
          <span className="visually-hidden">{prompt ? '' : 'Comando'}</span>
        </label>
        <input
          id="console-input"
          ref={inputRef}
          className="console-input"
          type={prompt?.secret ? 'password' : 'text'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={prompt ? answer : c.input}
          readOnly={c.running && !prompt}
          placeholder={c.running && !prompt ? 'executando… (Ctrl+C interrompe)' : prompt ? '' : 'digite um comando — help'}
          onChange={(e) => {
            if (prompt) setAnswer(e.target.value)
            else {
              c.setInput(e.target.value)
              setCursor(null)
              setSearch(null)
              setOptions([])
            }
          }}
          onKeyDown={onKeyDown}
        />
        {c.running && !prompt && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={c.interrupt}>
            Interromper
          </button>
        )}
      </div>
    </div>
  )
}
