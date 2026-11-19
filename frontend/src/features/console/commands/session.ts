// login, ui e cli: entrar pela linha de comando e alternar entre os modos.

import { ApiError } from '@/shared/api/client'
import type { Mode } from '@/features/auth/lib/mode'
import type { CommandDef, Ctx } from '@/features/console/state/types'
import { CommandError } from '@/features/console/state/types'
import { note } from './shared'

/** Comandos disponíveis antes do login, no modo CLI. */
export const PUBLIC_COMMANDS = ['login', 'ui', 'cli', 'help', 'clear']

async function login(ctx: Ctx) {
  if (ctx.authenticated) {
    note(ctx, 'você já está autenticado', 'info')
    return
  }
  const username = await ctx.ask('Usuário')
  if (!username) {
    note(ctx, 'cancelado')
    return false
  }
  const password = await ctx.secret('Senha')
  if (!password) {
    note(ctx, 'cancelado')
    return false
  }
  try {
    await ctx.login(username, password)
  } catch (err) {
    // 401 aqui é usuário ou senha errados, não sessão expirada.
    if (err instanceof ApiError && err.status === 401) throw new CommandError('usuário ou senha incorretos')
    if (err instanceof ApiError) throw new CommandError(err.message)
    throw err
  }
  note(ctx, 'autenticado — digite help para ver os comandos', 'success')
}

function switchTo(mode: Mode) {
  return async (ctx: Ctx) => {
    if (ctx.mode === mode) {
      note(ctx, mode === 'ui' ? 'você já está na interface gráfica' : 'você já está no modo linha de comando', 'info')
      return
    }
    ctx.setMode(mode)
  }
}

export const sessionCommands: CommandDef[] = [
  {
    name: 'login',
    aliases: ['entrar'],
    group: 'Sessão',
    summary: 'entra com usuário e senha (a senha é digitada num campo mascarado)',
    details: 'No modo CLI, é o primeiro comando: antes do login só login, ui, cli, help e clear funcionam.',
    examples: ['login'],
    run: login,
  },
  {
    name: 'ui',
    aliases: ['interface', 'gui'],
    group: 'Sessão',
    summary: 'passa para a interface gráfica (a sessão continua a mesma)',
    examples: ['ui'],
    run: switchTo('ui'),
  },
  {
    name: 'cli',
    aliases: ['terminal'],
    group: 'Sessão',
    summary: 'passa para o modo só linha de comando (a sessão continua a mesma)',
    examples: ['cli'],
    run: switchTo('cli'),
  },
]

/** Antes do login: os demais comandos existem (para help e Tab), mas pedem login. */
export function requireLogin(commands: CommandDef[]): CommandDef[] {
  return commands.map((def) => ({
    ...def,
    subcommands: def.subcommands && requireLogin(def.subcommands),
    run:
      def.run && !PUBLIC_COMMANDS.includes(def.name)
        ? async () => {
            throw new CommandError('faça login primeiro: digite login')
          }
        : def.run,
  }))
}
