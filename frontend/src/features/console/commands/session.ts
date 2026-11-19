// login, ui e cli: entrar pela linha de comando e alternar entre os modos.

import { ApiError } from '@/shared/api/client'
import { errorMessage } from '@/shared/i18n/errors'
import type { Mode } from '@/features/auth/lib/mode'
import type { CommandDef, Ctx } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'
import { note } from './shared'

/** Comandos disponíveis antes do login, no modo CLI. */
export const PUBLIC_COMMANDS = ['login', 'ui', 'cli', 'help', 'clear', 'language']

async function login(ctx: Ctx) {
  if (ctx.authenticated) {
    note(ctx, ct('m.session.already'), 'info')
    return
  }
  const username = await ctx.ask(ct('m.session.username'))
  if (!username) {
    note(ctx, ct('m.common.cancelled'))
    return false
  }
  const password = await ctx.secret(ct('m.session.password'))
  if (!password) {
    note(ctx, ct('m.common.cancelled'))
    return false
  }
  try {
    await ctx.login(username, password)
  } catch (err) {
    // 401 aqui é usuário ou senha errados, não sessão expirada.
    if (err instanceof ApiError && err.status === 401) throw new CommandError(ct('m.session.badCredentials'))
    if (err instanceof ApiError) throw new CommandError(errorMessage(err))
    throw err
  }
  note(ctx, ct('m.session.ok'), 'success')
}

function switchTo(mode: Mode) {
  return async (ctx: Ctx) => {
    if (ctx.mode === mode) {
      note(ctx, ct(mode === 'ui' ? 'm.session.alreadyUi' : 'm.session.alreadyCli'), 'info')
      return
    }
    ctx.setMode(mode)
  }
}

export const sessionCommands: CommandDef[] = defineCommands([
  {
    name: 'login',
    aliases: ['entrar'],
    group: 'Sessão',
    examples: ['login'],
    run: login,
  },
  {
    name: 'ui',
    aliases: ['interface', 'gui'],
    group: 'Sessão',
    examples: ['ui'],
    run: switchTo('ui'),
  },
  {
    name: 'cli',
    aliases: ['terminal'],
    group: 'Sessão',
    examples: ['cli'],
    run: switchTo('cli'),
  },
])

/** Antes do login: os demais comandos existem (para help e Tab), mas pedem login. */
export function requireLogin(commands: CommandDef[]): CommandDef[] {
  return commands.map((def) => {
    // Copia os descritores: os textos do catálogo são lidos a cada acesso e precisam seguir o idioma.
    const copy = Object.defineProperties({} as CommandDef, Object.getOwnPropertyDescriptors(def))
    copy.subcommands = def.subcommands && requireLogin(def.subcommands)
    copy.run =
      def.run && !PUBLIC_COMMANDS.includes(def.name)
        ? async () => {
            throw new CommandError(ct('m.session.loginFirst'))
          }
        : def.run
    return copy
  })
}
