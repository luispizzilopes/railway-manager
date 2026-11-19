// Autocompletar por Tab a partir do registro e dos dados em cache.

import type { Dashboard } from '@/shared/api/types'
import { findCommand, optionsOf } from './parse'
import { STATES, flatten, projectNames } from './selectors'
import type { CommandDef, Completion } from './types'

export interface CompletionData {
  dashboard?: Dashboard
  schedules?: string[]
  actions?: string[]
  operations?: string[]
  pages?: string[]
  aliases?: string[]
}

export interface CompletionResult {
  /** Linha completada (igual à original se nada mudou). */
  line: string
  /** Opções a listar quando há mais de uma. */
  options: string[]
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]
  for (const v of values) while (!v.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1)
  return prefix
}

const unique = (xs: string[]) => [...new Set(xs)]

function selectorValues(word: string, d: Dashboard | undefined): string[] {
  if (!d) return ['all']
  const instances = flatten(d)
  const at = word.lastIndexOf('@')
  if (at !== -1) {
    const head = word.slice(0, at)
    const [proj, serv] = head.split('/')
    const envs = instances
      .filter((i) => head.toLowerCase() === 'all' || (i.projectName.toLowerCase() === proj.toLowerCase() && (!serv || i.service.toLowerCase() === serv.toLowerCase())))
      .map((i) => `${head}@${i.environment}`)
    return unique(envs)
  }
  const slash = word.indexOf('/')
  if (slash !== -1) {
    const proj = word.slice(0, slash).toLowerCase()
    return unique(instances.filter((i) => proj === '*' || i.projectName.toLowerCase() === proj).map((i) => `${word.slice(0, slash)}/${i.service}`))
  }
  return ['all', ...projectNames(d)]
}

function values(kind: Completion | undefined, word: string, data: CompletionData, commands: CommandDef[]): string[] {
  if (!kind) return []
  if (typeof kind === 'object') return kind.values
  const d = data.dashboard
  switch (kind) {
    case 'selector':
      return selectorValues(word, d)
    case 'project':
      return d ? projectNames(d) : []
    case 'environment':
      return d ? unique(flatten(d).map((i) => i.environment)) : []
    case 'service':
      return d ? unique(flatten(d).map((i) => i.service)) : []
    case 'state':
      return STATES
    case 'schedule':
      return data.schedules ?? []
    case 'action':
      return data.actions ?? []
    case 'operation':
      return data.operations ?? []
    case 'page':
      return [...(data.pages ?? []), ...(d ? projectNames(d) : [])]
    case 'command':
      return commands.map((c) => c.name)
  }
}

/** Completa a última palavra da linha (cursor no fim). */
export function complete(line: string, commands: CommandDef[], data: CompletionData = {}): CompletionResult {
  const start = line.lastIndexOf(';') + 1
  const segment = line.slice(start)
  const words = segment.trimStart().split(/\s+/)
  const word = words[words.length - 1] ?? ''
  const before = words.slice(0, -1)

  let candidates: string[]
  let list = commands
  let def: CommandDef | undefined
  let rest: string[] = []
  for (let i = 0; i < before.length; i++) {
    const found = findCommand(list, before[i])
    if (!found) {
      rest = before.slice(i)
      break
    }
    def = found
    if (!found.subcommands) {
      rest = before.slice(i + 1)
      break
    }
    list = found.subcommands
  }

  if (!def) {
    candidates = before.length === 0 ? [...commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]), ...(data.aliases ?? [])] : []
  } else if (def.subcommands && !def.run && list === def.subcommands && rest.length === 0) {
    candidates = def.subcommands.map((s) => s.name)
  } else if (word.startsWith('-')) {
    candidates = optionsOf(def).map((o) => `--${o.name}`)
  } else {
    const prev = rest[rest.length - 1]
    const option = prev?.startsWith('--') ? optionsOf(def).find((o) => `--${o.name}` === prev && o.value) : undefined
    if (option) {
      candidates = values(option.complete, word, data, commands)
    } else {
      // Posição do argumento, descontando opções e seus valores.
      let index = 0
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]
        if (t.startsWith('-')) {
          const o = optionsOf(def).find((x) => `--${x.name}` === t || `-${x.short}` === t)
          if (o?.value) i++
        } else index++
      }
      const args = def.args ?? []
      const arg = args[index] ?? (args.length && args[args.length - 1].variadic ? args[args.length - 1] : undefined)
      candidates = values(arg?.complete, word, data, commands)
    }
  }

  const matches = unique(candidates.filter((c) => c.toLowerCase().startsWith(word.toLowerCase())))
  if (matches.length === 0) return { line, options: [] }
  const prefix = line.slice(0, line.length - word.length)
  if (matches.length === 1) {
    const only = matches[0]
    const open = only.endsWith('/') || only.endsWith('@')
    return { line: `${prefix}${only}${open ? '' : ' '}`, options: [] }
  }
  const common = commonPrefix(matches)
  return { line: common.length > word.length ? prefix + common : line, options: matches.sort((a, b) => a.localeCompare(b)) }
}
