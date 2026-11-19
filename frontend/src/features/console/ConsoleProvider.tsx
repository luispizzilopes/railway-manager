// Estado do console compartilhado entre o painel (atalho) e a página /console:
// saída, histórico, apelidos, prompt de confirmação e o comando em andamento.

import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { api } from '@/shared/api/client'
import type { Mode } from '../auth/mode'
import { COMMANDS } from './commands'
import { clearInterruptedRestart, peekInterruptedRestart, restartCommand, restartNotice } from './commands/power'
import { carriesSecret, runLine } from './engine'
import { browserStore } from './store'
import type { Block, CommandDef, Ctx, Store } from './types'
import { Aborted } from './types'

export const HISTORY_LIMIT = 200
const OUTPUT_LIMIT = 500

export interface Prompt {
  question: string
  word?: string
  secret: boolean
  /** Pergunta de texto livre: sem o sufixo `[s/N]`. */
  plain?: boolean
  resolve: (answer: string | null) => void
}

export interface ConsoleState {
  blocks: { id: string; block: Block }[]
  running: boolean
  prompt: Prompt | null
  history: string[]
  aliases: Record<string, string>
  input: string
  setInput: (value: string) => void
  open: boolean
  setOpen: (open: boolean) => void
  run: (line: string) => Promise<void>
  answer: (text: string | null) => void
  interrupt: () => void
  clear: () => void
  commands: CommandDef[]
}

const ConsoleContext = createContext<ConsoleState | null>(null)

export function useConsole(): ConsoleState {
  const value = useContext(ConsoleContext)
  if (!value) throw new Error('useConsole fora do ConsoleProvider')
  return value
}

let seq = 0
const nextId = () => `b${++seq}`

export function ConsoleProvider({
  children,
  onLogout,
  store: givenStore,
  pollMs = 2000,
  commands = COMMANDS,
  authenticated = true,
  onLogin = async () => undefined,
  mode = 'ui',
  onMode = () => undefined,
}: {
  children: ReactNode
  onLogout: () => void | Promise<void>
  store?: Store
  pollMs?: number
  commands?: CommandDef[]
  authenticated?: boolean
  onLogin?: () => void | Promise<void>
  mode?: Mode
  onMode?: (mode: Mode) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const store = useMemo(() => givenStore ?? browserStore(), [givenStore])
  // Reinício que ficou pela metade (página recarregada entre as etapas): aviso e comando prontos.
  const [interrupted] = useState(() => peekInterruptedRestart({ store }))
  const [blocks, setBlocks] = useState<{ id: string; block: Block }[]>(() =>
    interrupted ? [{ id: nextId(), block: restartNotice(interrupted) }] : [],
  )
  const [running, setRunning] = useState(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [history, setHistory] = useState<string[]>(() => store.get<string[]>('history', []))
  const [aliases, setAliasesState] = useState<Record<string, string>>(() => store.get('aliases', {}))
  const [input, setInput] = useState(() => (interrupted ? restartCommand(interrupted) : ''))
  const [open, setOpen] = useState(interrupted !== null)
  const controller = useRef<AbortController | null>(null)
  const promptRef = useRef<Prompt | null>(null)
  const aliasesRef = useRef(aliases)

  const print = useCallback((block: Block) => {
    const id = nextId()
    setBlocks((bs) => [...bs, { id, block }].slice(-OUTPUT_LIMIT))
    return id
  }, [])
  const update = useCallback((id: string, block: Block) => {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { id, block } : b)))
  }, [])
  const clear = useCallback(() => setBlocks([]), [])

  const ask = useCallback(
    (question: string, secret: boolean, word?: string, plain?: boolean) =>
      new Promise<string | null>((resolve) => {
        const p: Prompt = {
          question,
          word,
          secret,
          plain,
          resolve: (answer) => {
            promptRef.current = null
            setPrompt(null)
            resolve(answer)
          },
        }
        promptRef.current = p
        setPrompt(p)
      }),
    [],
  )

  const setAliases = useCallback(
    (next: Record<string, string>) => {
      aliasesRef.current = next
      setAliasesState(next)
      store.set('aliases', next)
    },
    [store],
  )

  const makeCtx = useCallback(
    (signal: AbortSignal) =>
      (json: boolean): Ctx => ({
        api,
        print,
        update,
        clear,
        async confirm(question, options) {
          const answer = await ask(question, false, options?.word)
          print({ kind: 'input', text: `${question} ${answer ?? ''}` })
          if (answer === null) return false
          const text = answer.trim().toLowerCase()
          return options?.word ? text === options.word.toLowerCase() : ['s', 'sim', 'y', 'yes'].includes(text)
        },
        async ask(label) {
          const answer = await ask(label, false, undefined, true)
          print({ kind: 'input', text: `${label}: ${answer ?? '(cancelado)'}` })
          return answer?.trim() || null
        },
        async secret(label) {
          const answer = await ask(label, true)
          print({ kind: 'input', text: `${label}: ${answer ? '••••••••' : '(cancelado)'}` })
          return answer || null
        },
        signal,
        sleep: (ms) =>
          new Promise<void>((resolve, reject) => {
            if (signal.aborted) return reject(new Aborted())
            const timer = setTimeout(resolve, ms)
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(new Aborted())
              },
              { once: true },
            )
          }),
        now: () => new Date(),
        navigate: (to) => navigate(to),
        invalidate: () => void queryClient.invalidateQueries(),
        dashboard: (fresh) =>
          queryClient.fetchQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, staleTime: fresh ? 0 : 30_000 }),
        store,
        commands,
        aliases: aliasesRef.current,
        setAliases,
        json,
        logout: async () => {
          await onLogout()
        },
        authenticated,
        login: async (username, password) => {
          await api.login(username, password)
          await onLogin()
        },
        mode,
        setMode: onMode,
        pollMs,
      }),
    [ask, authenticated, clear, commands, mode, navigate, onLogin, onLogout, onMode, pollMs, print, queryClient, setAliases, store, update],
  )

  const run = useCallback(
    async (line: string) => {
      const text = line.trim()
      if (!text || controller.current) return
      print({ kind: 'input', text })
      if (!carriesSecret(text)) {
        setHistory((h) => {
          const next = [...h.filter((x) => x !== text), text].slice(-HISTORY_LIMIT)
          store.set('history', next)
          return next
        })
      }
      const abort = new AbortController()
      controller.current = abort
      setRunning(true)
      try {
        await runLine(text, makeCtx(abort.signal))
      } finally {
        controller.current = null
        setRunning(false)
      }
    },
    [makeCtx, print, store],
  )

  const answer = useCallback((text: string | null) => promptRef.current?.resolve(text), [])

  const interrupt = useCallback(() => {
    promptRef.current?.resolve(null)
    controller.current?.abort()
  }, [])

  // O aviso já foi mostrado: não repete no próximo carregamento.
  useEffect(() => {
    if (interrupted) clearInterruptedRestart({ store })
  }, [interrupted, store])

  // Atalhos globais: Ctrl+` alterna o painel. Ctrl+K abre a paleta de comandos (no Layout);
  // na página do console e no modo CLI ele só leva o foco à linha de comando.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const focusOnly = pathname === '/console' || mode === 'cli'
      if (e.key === '`') {
        e.preventDefault()
        if (focusOnly) document.getElementById('console-input')?.focus()
        else setOpen((o) => !o)
      } else if (e.key.toLowerCase() === 'k' && focusOnly) {
        e.preventDefault()
        document.getElementById('console-input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, pathname])

  const value: ConsoleState = {
    blocks,
    running,
    prompt,
    history,
    aliases,
    input,
    setInput,
    open,
    setOpen,
    run,
    answer,
    interrupt,
    clear,
    commands,
  }
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
}
