// A ajuda embutida e docs/console.md descrevem os mesmos comandos e opções.

import { describe, expect, it } from 'vitest'

import { COMMANDS } from './commands'
import { leaves } from './help'
import { GLOBAL_OPTIONS } from './parse'
import type { CommandDef } from './types'
import markdown from '../../../docs/console.md?raw'

/** Seções `### \`caminho\`` (ou `####`) e as opções listadas nas tabelas de cada uma. */
function documented(markdown: string): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>()
  let current: Set<string> | null = null
  for (const line of markdown.split('\n')) {
    const heading = /^#{3,4} `([^`]+)`\s*$/.exec(line)
    if (heading) {
      current = new Set()
      sections.set(heading[1], current)
      continue
    }
    if (/^#{1,4} /.test(line)) {
      current = null
      continue
    }
    if (current && line.startsWith('|')) {
      const cell = line.split('|')[1] ?? ''
      for (const m of cell.matchAll(/--([a-z][a-z-]*)/g)) current.add(m[1])
    }
  }
  return sections
}

function registered(commands: CommandDef[]): Map<string, Set<string>> {
  return new Map(leaves(commands).map(({ path, def }) => [path.join(' '), new Set((def.options ?? []).map((o) => o.name))]))
}

function compare(doc: Map<string, Set<string>>, reg: Map<string, Set<string>>): string[] {
  const problems: string[] = []
  for (const [path, options] of reg) {
    const section = doc.get(path)
    if (!section) {
      problems.push(`comando sem seção em docs/console.md: ${path}`)
      continue
    }
    for (const o of options) if (!section.has(o)) problems.push(`${path}: opção --${o} não documentada`)
    for (const o of section) if (!options.has(o)) problems.push(`${path}: docs cita --${o}, que o comando não tem`)
  }
  for (const path of doc.keys()) if (!reg.has(path)) problems.push(`docs/console.md documenta comando inexistente: ${path}`)
  return problems
}

describe('documentação do console', () => {
  it('registro e docs/console.md têm os mesmos comandos e opções', () => {
    expect(compare(documented(markdown), registered(COMMANDS))).toEqual([])
  })

  it('as opções globais estão documentadas', () => {
    for (const o of GLOBAL_OPTIONS) expect(markdown).toContain(`\`--${o.name}\``)
  })

  it('falha quando um comando some da documentação', () => {
    const without = markdown.replace(/^### `refresh`$/m, '### refresh (removido)')
    expect(compare(documented(without), registered(COMMANDS))).toContain('comando sem seção em docs/console.md: refresh')
    const extra: CommandDef[] = [...COMMANDS, { name: 'novo', group: 'X', summary: 'x', run: async () => undefined }]
    expect(compare(documented(markdown), registered(extra))).toContain('comando sem seção em docs/console.md: novo')
  })

  it('cada comando tem resumo, exemplos e ajuda para todas as opções', () => {
    for (const { path, def } of leaves(COMMANDS)) {
      expect(def.summary, path.join(' ')).toBeTruthy()
      expect(def.examples?.length ?? 0, `${path.join(' ')} sem exemplo`).toBeGreaterThan(0)
      for (const o of def.options ?? []) expect(o.help, `${path.join(' ')} --${o.name}`).toBeTruthy()
    }
  })
})
