// Termos + registro → invocação validada. Nenhum erro aqui chega a chamar a API.

import { ct } from '@/features/console/lib/i18n'
import { tokenize } from './lexer'
import type { CommandDef, Invocation, OptionDef, OptionValue } from '@/features/console/state/types'
import { CommandError } from '@/features/console/state/types'

/** Opções aceitas por qualquer comando. */
export const GLOBAL_OPTIONS: OptionDef[] = [
  Object.defineProperty({ name: 'json' } as OptionDef, 'help', { enumerable: true, get: () => ct('globalOpt.json') }),
  Object.defineProperty({ name: 'help', short: 'h' } as OptionDef, 'help', { enumerable: true, get: () => ct('globalOpt.help') }),
]

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Candidatos parecidos: mesmo prefixo, contém, ou até 2 edições. */
export function similar(input: string, candidates: string[], max = 5): string[] {
  const needle = input.toLowerCase()
  const scored = candidates
    .map((c) => {
      const lower = c.toLowerCase()
      const distance = levenshtein(needle, lower)
      const score = lower.startsWith(needle) || needle.startsWith(lower) ? 0 : lower.includes(needle) ? 1 : 2
      return { c, score, distance }
    })
    // Sem prefixo em comum: 1 edição para termos curtos, até 2 para os demais.
    .filter((x) => x.score < 2 || x.distance <= (needle.length <= 4 ? 1 : 2))
    .sort((a, b) => a.score - b.score || a.distance - b.distance || a.c.localeCompare(b.c))
  return [...new Set(scored.map((x) => x.c))].slice(0, max)
}

function names(def: CommandDef): string[] {
  return [def.name, ...(def.aliases ?? [])]
}

export function findCommand(list: CommandDef[], name: string): CommandDef | undefined {
  const lower = name.toLowerCase()
  return list.find((d) => names(d).includes(lower))
}

function suggestion(input: string, list: CommandDef[]): string {
  const [best] = similar(input, list.flatMap(names), 1)
  if (!best) return ''
  const def = findCommand(list, best)
  return ct('m.parse.didYouMean', { name: def?.name ?? best })
}

/** Opções do comando + globais. */
export function optionsOf(def: CommandDef): OptionDef[] {
  return [...(def.options ?? []), ...GLOBAL_OPTIONS]
}

/** Expande o apelido no primeiro termo (apelidos nunca substituem comandos). */
export function expandAlias(
  tokens: string[],
  commands: CommandDef[],
  aliases: Record<string, string>,
): string[][] {
  const [first, ...rest] = tokens
  const expansion = first !== undefined && !findCommand(commands, first) ? aliases[first] : undefined
  if (expansion === undefined) return [tokens]
  const expanded = tokenize(expansion)
  if (expanded.length === 0) return [rest]
  expanded[expanded.length - 1] = [...expanded[expanded.length - 1], ...rest]
  return expanded
}

/** Resolve o comando (e subcomandos) e separa argumentos e opções. */
export function parse(tokens: string[], commands: CommandDef[], line = tokens.join(' ')): Invocation {
  if (tokens.length === 0) throw new CommandError(ct('m.parse.emptyLine'))
  let list = commands
  let def: CommandDef | undefined
  const path: string[] = []
  let i = 0
  for (; i < tokens.length; i++) {
    const found = findCommand(list, tokens[i])
    if (!found) {
      if (!def) throw new CommandError(ct('m.parse.unknownCommand', { token: tokens[i], hint: suggestion(tokens[i], list) }))
      break
    }
    def = found
    path.push(found.name)
    if (!found.subcommands) {
      i++
      break
    }
    list = found.subcommands
  }
  if (!def) throw new CommandError(ct('m.parse.emptyLine'))

  const rest = tokens.slice(i)
  const wantsHelp = rest.some((t) => t === '--help' || t === '-h')
  if (def.subcommands && !def.run) {
    if (wantsHelp || rest.length === 0) {
      if (wantsHelp) return { path, def, args: [], options: { help: true }, line }
      const subs = def.subcommands.map((s) => s.name).join('|')
      throw new CommandError(ct('m.parse.usageSub', { path: path.join(' '), subs }))
    }
    const [unknown] = rest
    throw new CommandError(ct('m.parse.unknownSub', { path: path.join(' '), token: unknown, hint: suggestion(unknown, def.subcommands) }))
  }

  const defs = optionsOf(def)
  const options: Record<string, OptionValue> = {}
  const args: string[] = []
  let positionalOnly = false
  for (let j = 0; j < rest.length; j++) {
    const token = rest[j]
    if (positionalOnly || token === '-' || !token.startsWith('-') || /^-\d/.test(token)) {
      args.push(token)
      continue
    }
    if (token === '--') {
      positionalOnly = true
      continue
    }
    let name: string
    let inline: string | undefined
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      inline = eq === -1 ? undefined : token.slice(eq + 1)
    } else {
      name = token.slice(1)
    }
    const option = token.startsWith('--')
      ? defs.find((o) => o.name === name)
      : defs.find((o) => o.short === name)
    if (!option) {
      const known = defs.map((o) => `--${o.name}`)
      const [close] = similar(`--${name}`, known, 1)
      throw new CommandError(
        ct('m.parse.unknownOption', { path: path.join(' '), token, hint: close ? ct('m.parse.didYouMean', { name: close }) : '' }),
      )
    }
    let value: string | true
    if (option.value) {
      if (inline !== undefined) value = inline
      else if (j + 1 < rest.length) value = rest[++j]
      else throw new CommandError(ct('m.parse.needsValue', { name: option.name, value: option.value }))
    } else {
      if (inline !== undefined) throw new CommandError(ct('m.parse.noValue', { name: option.name }))
      value = true
    }
    if (option.repeatable) {
      const prev = options[option.name]
      options[option.name] = [...(Array.isArray(prev) ? prev : []), String(value)]
    } else if (option.name in options && option.value) {
      throw new CommandError(ct('m.parse.twice', { name: option.name }))
    } else {
      options[option.name] = value
    }
  }

  if (!options.help) {
    const specs = def.args ?? []
    const required = specs.filter((a) => a.required)
    if (args.length < required.length) {
      const missing = required[args.length]
      throw new CommandError(ct('m.parse.missingArg', { name: missing.name, usage: usage(path, def) }))
    }
    const variadic = specs.some((a) => a.variadic)
    if (!variadic && args.length > specs.length) {
      throw new CommandError(ct('m.parse.tooMany', { path: path.join(' '), args: args.slice(specs.length).join(' ') }))
    }
  }
  return { path, def, args, options, line }
}

export function usage(path: string[], def: CommandDef): string {
  return `${path.join(' ')}${def.usage ? ` ${def.usage}` : ''}`
}

// ---------- leitura de opções ----------

export function flag(inv: Invocation, name: string): boolean {
  return inv.options[name] === true
}

export function str(inv: Invocation, name: string): string | undefined {
  const v = inv.options[name]
  return typeof v === 'string' ? v : undefined
}

export function list(inv: Invocation, name: string): string[] {
  const v = inv.options[name]
  if (Array.isArray(v)) return v.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)
  return typeof v === 'string' ? [v] : []
}

export function int(inv: Invocation, name: string, fallback: number): number {
  const raw = str(inv, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new CommandError(ct('m.parse.positiveInt', { name, raw }))
  return n
}
