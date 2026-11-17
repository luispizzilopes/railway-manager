// Ajuda gerada do registro de comandos (a mesma fonte da referência em docs/console.md).

import { GLOBAL_OPTIONS, findCommand, usage } from './parse'
import type { Block, CommandDef, OptionDef } from './types'
import { CommandError } from './types'

export function optionLabel(o: OptionDef): string {
  const long = `--${o.name}${o.value ? ` <${o.value}>` : ''}`
  return o.short ? `-${o.short}, ${long}` : long
}

/** Comando pelo caminho (nomes ou apelidos). */
export function lookup(commands: CommandDef[], path: string[]): { def: CommandDef; path: string[] } {
  let list = commands
  let def: CommandDef | undefined
  const canonical: string[] = []
  for (const name of path) {
    const found = findCommand(list, name)
    if (!found) {
      throw new CommandError(`sem ajuda para '${[...canonical, name].join(' ')}': comando desconhecido — veja help`)
    }
    def = found
    canonical.push(found.name)
    list = found.subcommands ?? []
  }
  if (!def) throw new CommandError('informe um comando')
  return { def, path: canonical }
}

/** Todos os comandos executáveis, com o caminho completo. */
export function leaves(commands: CommandDef[], prefix: string[] = []): { path: string[]; def: CommandDef }[] {
  return commands.flatMap((def) => {
    const path = [...prefix, def.name]
    const self = def.run ? [{ path, def }] : []
    return [...self, ...leaves(def.subcommands ?? [], path)]
  })
}

function overview(commands: CommandDef[]): Block[] {
  const groups = new Map<string, CommandDef[]>()
  for (const def of commands) groups.set(def.group, [...(groups.get(def.group) ?? []), def])
  const blocks: Block[] = [
    {
      kind: 'text',
      text: 'Comandos do Railway Manager. Use `help <comando>` (ou `<comando> --help`) para ver opções e exemplos.',
    },
  ]
  for (const [group, defs] of groups) {
    blocks.push({
      kind: 'table',
      title: group,
      columns: ['Comando', 'Também', 'Descrição'],
      rows: defs.map((d) => [
        d.subcommands ? `${d.name} <${d.subcommands.map((s) => s.name).join('|')}>` : d.name,
        (d.aliases ?? []).join(', '),
        d.summary,
      ]),
    })
  }
  blocks.push({
    kind: 'text',
    tone: 'muted',
    text:
      'Seletores: all · projeto · projeto@ambiente · projeto/serviço · projeto/serviço@ambiente · curinga * (ex.: */worker).\n' +
      'Atalhos: Ctrl+` ou Ctrl+K abre/fecha · ↑/↓ histórico · Ctrl+R busca · Tab completa · Ctrl+C interrompe · Ctrl+L limpa.',
  })
  return blocks
}

export function helpBlocks(commands: CommandDef[], path: string[]): Block[] {
  if (path.length === 0) return overview(commands)
  const { def, path: canonical } = lookup(commands, path)
  const blocks: Block[] = [{ kind: 'text', text: `${canonical.join(' ')} — ${def.summary}` }]
  const lines: string[] = []
  if (def.subcommands && !def.run) {
    lines.push(`uso: ${canonical.join(' ')} <${def.subcommands.map((s) => s.name).join('|')}> …`)
  } else {
    lines.push(`uso: ${usage(canonical, def)}`)
  }
  if (def.aliases?.length) lines.push(`também: ${def.aliases.join(', ')}`)
  if (def.details) lines.push('', def.details)
  blocks.push({ kind: 'text', text: lines.join('\n') })
  if (def.subcommands) {
    blocks.push({
      kind: 'table',
      title: 'Subcomandos',
      columns: ['Subcomando', 'Também', 'Descrição'],
      rows: def.subcommands.map((s) => [`${s.name}${s.usage ? ` ${s.usage}` : ''}`, (s.aliases ?? []).join(', '), s.summary]),
    })
  }
  if (def.args?.length) {
    blocks.push({
      kind: 'table',
      title: 'Argumentos',
      columns: ['Argumento', 'Descrição'],
      rows: def.args.map((a) => [`<${a.name}${a.variadic ? '...' : ''}>${a.required ? '' : ' (opcional)'}`, a.help]),
    })
  }
  if (def.run) {
    blocks.push({
      kind: 'table',
      title: 'Opções',
      columns: ['Opção', 'Padrão', 'Descrição'],
      rows: [...(def.options ?? []), ...GLOBAL_OPTIONS].map((o) => [
        optionLabel(o) + (o.repeatable ? ' (repetível)' : ''),
        o.default ?? '—',
        o.help,
      ]),
    })
  }
  if (def.examples?.length) {
    blocks.push({ kind: 'text', text: ['Exemplos:', ...def.examples.map((e) => `  ${e}`)].join('\n') })
  }
  return blocks
}
