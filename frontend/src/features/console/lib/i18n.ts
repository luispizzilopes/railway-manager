// Textos do console: tradução no idioma ativo e registro de comandos com textos vindos do catálogo.

import type { ParseKeys, TOptions } from 'i18next'

import { i18n } from '@/shared/i18n'
import type { ArgDef, CommandDef, CommandSource, OptionDef } from '@/features/console/state/types'

/** Tradução do namespace `console` (usada fora de componentes React). */
export function ct(key: ParseKeys<'console'>, options?: TOptions): string {
  return i18n.t(key, { ...options, ns: 'console' }) as string
}

// Chaves montadas em tempo de execução (caminho do comando): fora da checagem de tipos das chaves.
const translate = i18n.t.bind(i18n) as unknown as (key: string, options?: object) => string
const exists = (key: string) => i18n.exists(key, { ns: 'console' })
const text = (key: string, options?: TOptions) => translate(key, { ...options, ns: 'console' })
const lazy = <T extends object>(target: T, name: string, get: () => unknown): T =>
  Object.defineProperty(target, name, { enumerable: true, configurable: true, get })

function localizeArg(base: string, arg: Omit<ArgDef, 'help'>): ArgDef {
  const own = `${base}.args.${arg.name}`
  return lazy({ ...arg } as ArgDef, 'help', () => text(exists(own) ? own : `arg.${arg.name}`))
}

function localizeOption(base: string, option: Omit<OptionDef, 'help'>): OptionDef {
  const own = `${base}.options.${option.name}`
  const out = lazy({ ...option } as OptionDef, 'help', () => text(exists(`${own}.help`) ? `${own}.help` : `opt.${option.name}.help`))
  return lazy(out, 'default', () => (exists(`${own}.default`) ? text(`${own}.default`) : undefined))
}

/** Aplica os textos do catálogo (lidos a cada acesso, então acompanham o idioma ativo). */
export function defineCommands(sources: CommandSource[], parent: string[] = []): CommandDef[] {
  return sources.map((source) => {
    const path = [...parent, source.name]
    const base = `cmd.${path.join('/')}`
    const def = { ...source } as CommandDef
    lazy(def, 'summary', () => text(`${base}.summary`))
    lazy(def, 'details', () => (exists(`${base}.details`) ? text(`${base}.details`) : undefined))
    if (source.args) def.args = source.args.map((a) => localizeArg(base, a))
    if (source.options) def.options = source.options.map((o) => localizeOption(base, o))
    if (source.subcommands) def.subcommands = defineCommands(source.subcommands, path)
    return def
  })
}

/** Nome do grupo de comandos no idioma ativo (grupos desconhecidos ficam como estão). */
export function groupLabel(group: string): string {
  return translate(`group.${group}`, { ns: 'console', defaultValue: group })
}
