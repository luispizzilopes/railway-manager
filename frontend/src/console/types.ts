// Tipos do console: registro declarativo de comandos, invocação, blocos de saída e contexto.

import type { api } from '../api/client'
import type {
  Dashboard,
  ItemResult,
  ObservedState,
  OperationItem,
  OperationStatus,
  Plan,
  PowerKind,
} from '../api/types'

/** Tipo de valor que o autocompletar sabe sugerir. */
export type Completion =
  | 'selector'
  | 'project'
  | 'environment'
  | 'service'
  | 'state'
  | 'schedule'
  | 'action'
  | 'operation'
  | 'command'
  | 'page'
  | { values: string[] }

export interface OptionDef {
  /** Nome longo, sem `--`. */
  name: string
  short?: string
  /** Rótulo do valor (ex.: `ambiente`); ausente = opção sem valor (flag). */
  value?: string
  repeatable?: boolean
  default?: string
  help: string
  complete?: Completion
}

export interface ArgDef {
  name: string
  required?: boolean
  variadic?: boolean
  help: string
  complete?: Completion
}

export interface CommandDef {
  name: string
  /** Nomes alternativos (em português). */
  aliases?: string[]
  group: string
  summary: string
  /** Sintaxe sem o nome, ex.: `<seletor...> [opções]`. */
  usage?: string
  args?: ArgDef[]
  options?: OptionDef[]
  examples?: string[]
  /** Texto extra para `help <comando>`. */
  details?: string
  subcommands?: CommandDef[]
  run?: (ctx: Ctx, inv: Invocation) => Promise<boolean | void>
}

export type OptionValue = string | boolean | string[]

export interface Invocation {
  /** Caminho canônico, ex.: `['project', 'import']`. */
  path: string[]
  def: CommandDef
  args: string[]
  options: Record<string, OptionValue>
  /** Linha original (para mensagens). */
  line: string
}

// ---------- saída ----------

export type Tone = 'muted' | 'error' | 'success' | 'warn' | 'info'

export type Cell =
  | string
  | number
  | null
  | { state: ObservedState }
  | { result: ItemResult }
  | { id: string }
  | { text: string; tone: Tone }

export type Block =
  | { kind: 'input'; text: string }
  | { kind: 'text'; text: string; tone?: Tone }
  | { kind: 'table'; title?: string; columns: string[]; rows: Cell[][] }
  | { kind: 'json'; value: unknown }
  | { kind: 'plan'; plan: Plan }
  | {
      kind: 'progress'
      operationId: string
      powerKind: PowerKind
      status: OperationStatus | null
      items: OperationItem[]
      done: boolean
      detached?: boolean
    }
  | { kind: 'error'; message: string; status?: number; code?: string; details?: unknown }

export interface ConfirmOptions {
  /** Palavra a digitar (ex.: `tudo`); sem ela, `s`/`N`. */
  word?: string
}

/** Armazenamento do navegador tolerante a falhas. */
export interface Store {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  remove(key: string): void
}

export interface Ctx {
  api: typeof api
  print(block: Block): string
  update(id: string, block: Block): void
  clear(): void
  confirm(question: string, options?: ConfirmOptions): Promise<boolean>
  secret(label: string): Promise<string | null>
  signal: AbortSignal
  sleep(ms: number): Promise<void>
  now(): Date
  navigate(to: string): void
  /** Invalida as consultas da interface depois de um comando com efeito. */
  invalidate(): void
  /** Visão geral; `fresh` força nova leitura (antes de comandos com efeito). */
  dashboard(fresh?: boolean): Promise<Dashboard>
  store: Store
  commands: CommandDef[]
  aliases: Record<string, string>
  setAliases(next: Record<string, string>): void
  /** `--json` global. */
  json: boolean
  logout(): Promise<void>
  /** Intervalo do acompanhamento de operações. */
  pollMs: number
}

/** Erro de uso exibido sem pilha. */
export class CommandError extends Error {
  readonly details?: unknown

  constructor(message: string, details?: unknown) {
    super(message)
    this.details = details
  }
}

export class Aborted extends Error {
  constructor() {
    super('interrompido')
  }
}
