// Ajuda gerada do registro de comandos (a mesma fonte da referência em docs/console.md).

import { ct, groupLabel } from '@/features/console/lib/i18n'
import { GLOBAL_OPTIONS, findCommand, usage } from '@/features/console/engine/parse'
import type { Block, CommandDef, OptionDef } from '@/features/console/state/types'
import { CommandError } from '@/features/console/state/types'

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
      throw new CommandError(ct('m.help.noHelp', { path: [...canonical, name].join(' ') }))
    }
    def = found
    canonical.push(found.name)
    list = found.subcommands ?? []
  }
  if (!def) throw new CommandError(ct('m.help.needCommand'))
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
      text: ct('m.help.intro'),
    },
  ]
  for (const [group, defs] of groups) {
    blocks.push({
      kind: 'table',
      title: groupLabel(group),
      columns: [ct('m.help.cols.command'), ct('m.help.cols.also'), ct('m.help.cols.description')],
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
    text: ct('m.help.footer'),
  })
  return blocks
}

export function helpBlocks(commands: CommandDef[], path: string[]): Block[] {
  if (path.length === 0) return overview(commands)
  const { def, path: canonical } = lookup(commands, path)
  const blocks: Block[] = [{ kind: 'text', text: `${canonical.join(' ')} — ${def.summary}` }]
  const lines: string[] = []
  if (def.subcommands && !def.run) {
    lines.push(ct('m.help.usageSub', { path: canonical.join(' '), subs: def.subcommands.map((s) => s.name).join('|') }))
  } else {
    lines.push(ct('m.help.usage', { usage: usage(canonical, def) }))
  }
  if (def.aliases?.length) lines.push(ct('m.help.also', { list: def.aliases.join(', ') }))
  if (def.details) lines.push('', def.details)
  blocks.push({ kind: 'text', text: lines.join('\n') })
  if (def.subcommands) {
    blocks.push({
      kind: 'table',
      title: ct('m.help.subcommands'),
      columns: [ct('m.help.cols.subcommand'), ct('m.help.cols.also'), ct('m.help.cols.description')],
      rows: def.subcommands.map((s) => [`${s.name}${s.usage ? ` ${s.usage}` : ''}`, (s.aliases ?? []).join(', '), s.summary]),
    })
  }
  if (def.args?.length) {
    blocks.push({
      kind: 'table',
      title: ct('m.help.arguments'),
      columns: [ct('m.help.cols.argument'), ct('m.help.cols.description')],
      rows: def.args.map((a) => [`<${a.name}${a.variadic ? '...' : ''}>${a.required ? '' : ct('m.help.optional')}`, a.help]),
    })
  }
  if (def.run) {
    blocks.push({
      kind: 'table',
      title: ct('m.help.options'),
      columns: [ct('m.help.cols.option'), ct('m.help.cols.default'), ct('m.help.cols.description')],
      rows: [...(def.options ?? []), ...GLOBAL_OPTIONS].map((o) => [
        optionLabel(o) + (o.repeatable ? ct('m.help.repeatable') : ''),
        o.default ?? '—',
        o.help,
      ]),
    })
  }
  if (def.examples?.length) {
    blocks.push({ kind: 'text', text: [ct('m.help.examples'), ...def.examples.map((e) => `  ${e}`)].join('\n') })
  }
  return blocks
}
