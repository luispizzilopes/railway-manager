// help, clear, open, logout, alias, unalias.

import { LANGUAGES, currentLanguage, setLanguage } from '@/shared/i18n'
import { findCommand } from '@/features/console/engine/parse'
import { findProject } from '@/features/console/state/selectors'
import { helpBlocks } from '@/features/console/lib/help'
import type { CommandDef, Ctx, Invocation } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'
import { note, show } from './shared'

export const PAGES: Record<string, string> = {
  overview: '/',
  visao: '/',
  inicio: '/',
  projects: '/projects',
  projetos: '/projects',
  schedules: '/schedules',
  agendas: '/schedules',
  history: '/history',
  historico: '/history',
  settings: '/settings',
  config: '/settings',
  console: '/console',
}

async function help(ctx: Ctx, inv: Invocation) {
  for (const block of helpBlocks(ctx.commands, inv.args)) ctx.print(block)
}

async function language(ctx: Ctx, inv: Invocation) {
  const value = inv.args[0]
  if (value === undefined) {
    note(ctx, ct('m.lang.current', { language: currentLanguage(), list: LANGUAGES.join(', ') }))
    return
  }
  const chosen = LANGUAGES.find((l) => l.toLowerCase() === value.toLowerCase()) ?? (value.toLowerCase() === 'pt' ? 'pt-BR' : undefined)
  if (!chosen) throw new CommandError(ct('m.lang.invalid', { value, list: LANGUAGES.join(', ') }))
  await setLanguage(chosen)
  note(ctx, ct('m.lang.set', { language: chosen }), 'success')
}

async function open(ctx: Ctx, inv: Invocation) {
  const target = inv.args[0]
  let to = PAGES[target.toLowerCase()]
  if (!to) to = `/projects/${findProject(await ctx.dashboard(), target).project.id}`
  ctx.navigate(to)
  // No modo CLI não há telas: abrir uma passa para a interface gráfica.
  if (ctx.mode === 'cli') ctx.setMode('ui')
}

const ALIAS_NAME = /^[\p{L}\d_-]+$/u

async function alias(ctx: Ctx, inv: Invocation) {
  const text = inv.args.join(' ')
  if (!text) {
    const entries = Object.entries(ctx.aliases)
    show(ctx, ctx.aliases, {
      kind: 'table',
      columns: [ct('m.misc.aliasTitle.alias'), ct('m.misc.aliasTitle.expansion')],
      rows: entries.map(([k, v]) => [k, v]),
    })
    if (entries.length === 0) note(ctx, ct('m.misc.noAliases'))
    return
  }
  const eq = text.indexOf('=')
  if (eq <= 0) throw new CommandError(ct('m.misc.aliasUsage'))
  const name = text.slice(0, eq).trim()
  const expansion = text.slice(eq + 1).trim()
  if (!ALIAS_NAME.test(name)) throw new CommandError(ct('m.misc.aliasInvalid', { name }))
  if (findCommand(ctx.commands, name)) throw new CommandError(ct('m.misc.aliasIsCommand', { name }))
  if (!expansion) throw new CommandError(ct('m.misc.aliasEmpty'))
  ctx.setAliases({ ...ctx.aliases, [name]: expansion })
  note(ctx, ct('m.misc.aliasSet', { name, expansion }), 'success')
}

async function unalias(ctx: Ctx, inv: Invocation) {
  const name = inv.args[0]
  if (!(name in ctx.aliases)) throw new CommandError(ct('m.misc.noAlias', { name }))
  const next = { ...ctx.aliases }
  delete next[name]
  ctx.setAliases(next)
  note(ctx, ct('m.misc.aliasRemoved', { name }), 'success')
}

export const miscCommands: CommandDef[] = defineCommands([
  {
    name: 'help',
    aliases: ['ajuda', '?'],
    group: 'Console',
    usage: '[comando...]',
    args: [{ name: 'comando', variadic: true, complete: 'command' }],
    examples: ['help', 'help stop', 'ajuda schedule create'],
    run: help,
  },
  {
    name: 'clear',
    aliases: ['limpar', 'cls'],
    group: 'Console',
    examples: ['clear'],
    run: async (ctx) => ctx.clear(),
  },
  {
    name: 'open',
    aliases: ['abrir'],
    group: 'Console',
    usage: '<página|projeto>',
    args: [
      {
        name: 'destino',
        required: true,
        complete: 'page',
      },
    ],
    examples: ['open history', 'open loja'],
    run: open,
  },
  {
    name: 'alias',
    aliases: ['apelido'],
    group: 'Console',
    usage: '[<nome>=<expansão>]',
    args: [{ name: 'definição', variadic: true }],
    examples: ['alias', 'alias fimdodia="stop all --except infra -y"', 'alias bomdia="start all --env production -y"'],
    run: alias,
  },
  {
    name: 'unalias',
    group: 'Console',
    usage: '<nome>',
    args: [{ name: 'nome', required: true }],
    examples: ['unalias fimdodia'],
    run: unalias,
  },
  {
    name: 'language',
    aliases: ['idioma', 'lang'],
    group: 'Console',
    usage: '[idioma]',
    args: [{ name: 'idioma', complete: { values: [...LANGUAGES] } }],
    examples: ['language', 'language en', 'idioma pt-BR'],
    run: language,
  },
  {
    name: 'logout',
    aliases: ['sair'],
    group: 'Console',
    examples: ['logout'],
    run: async (ctx) => {
      await ctx.logout()
      note(ctx, ct('m.misc.loggedOut'), 'success')
    },
  },
])
