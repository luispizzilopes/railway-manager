// help, clear, open, logout, alias, unalias.

import { findCommand } from '../parse'
import { findProject } from '../selectors'
import { helpBlocks } from '../help'
import type { CommandDef, Ctx, Invocation } from '../types'
import { CommandError } from '../types'
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

async function open(ctx: Ctx, inv: Invocation) {
  const target = inv.args[0]
  const page = PAGES[target.toLowerCase()]
  if (page) {
    ctx.navigate(page)
    return
  }
  const { project } = findProject(await ctx.dashboard(), target)
  ctx.navigate(`/projects/${project.id}`)
}

const ALIAS_NAME = /^[\p{L}\d_-]+$/u

async function alias(ctx: Ctx, inv: Invocation) {
  const text = inv.args.join(' ')
  if (!text) {
    const entries = Object.entries(ctx.aliases)
    show(ctx, ctx.aliases, {
      kind: 'table',
      columns: ['Apelido', 'Expansão'],
      rows: entries.map(([k, v]) => [k, v]),
    })
    if (entries.length === 0) note(ctx, 'nenhum apelido — crie com: alias fimdodia="stop all -y"')
    return
  }
  const eq = text.indexOf('=')
  if (eq <= 0) throw new CommandError('use alias <nome>=<expansão> (ex.: alias fimdodia="stop all --except infra -y")')
  const name = text.slice(0, eq).trim()
  const expansion = text.slice(eq + 1).trim()
  if (!ALIAS_NAME.test(name)) throw new CommandError(`nome de apelido inválido: '${name}' (letras, números, _ e -)`)
  if (findCommand(ctx.commands, name)) throw new CommandError(`'${name}' já é um comando: apelidos não substituem comandos`)
  if (!expansion) throw new CommandError('a expansão do apelido está vazia')
  ctx.setAliases({ ...ctx.aliases, [name]: expansion })
  note(ctx, `apelido ${name} → ${expansion}`, 'success')
}

async function unalias(ctx: Ctx, inv: Invocation) {
  const name = inv.args[0]
  if (!(name in ctx.aliases)) throw new CommandError(`nenhum apelido '${name}'`)
  const next = { ...ctx.aliases }
  delete next[name]
  ctx.setAliases(next)
  note(ctx, `apelido ${name} removido`, 'success')
}

export const miscCommands: CommandDef[] = [
  {
    name: 'help',
    aliases: ['ajuda', '?'],
    group: 'Console',
    summary: 'lista os comandos ou mostra a ajuda de um comando',
    usage: '[comando...]',
    args: [{ name: 'comando', variadic: true, help: 'ex.: stop, project import', complete: 'command' }],
    examples: ['help', 'help stop', 'ajuda schedule create'],
    run: help,
  },
  {
    name: 'clear',
    aliases: ['limpar', 'cls'],
    group: 'Console',
    summary: 'limpa a saída (Ctrl+L)',
    examples: ['clear'],
    run: async (ctx) => ctx.clear(),
  },
  {
    name: 'open',
    aliases: ['abrir'],
    group: 'Console',
    summary: 'abre uma tela da interface ou a página de um projeto',
    usage: '<página|projeto>',
    args: [
      {
        name: 'destino',
        required: true,
        help: `${Object.keys(PAGES).join(', ')} ou nome do projeto`,
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
    summary: 'cria ou lista apelidos (guardados neste navegador)',
    usage: '[<nome>=<expansão>]',
    args: [{ name: 'definição', variadic: true, help: 'nome=expansão; sem argumentos, lista' }],
    examples: ['alias', 'alias fimdodia="stop all --except infra -y"', 'alias bomdia="start all --env production -y"'],
    run: alias,
  },
  {
    name: 'unalias',
    group: 'Console',
    summary: 'remove um apelido',
    usage: '<nome>',
    args: [{ name: 'nome', required: true, help: 'apelido a remover' }],
    examples: ['unalias fimdodia'],
    run: unalias,
  },
  {
    name: 'logout',
    aliases: ['sair'],
    group: 'Console',
    summary: 'encerra a sessão',
    examples: ['logout'],
    run: async (ctx) => ctx.logout(),
  },
]
