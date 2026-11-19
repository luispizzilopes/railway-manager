import { describe, expect, it } from 'vitest'

import { quote, tokenize } from './lexer'
import { expandAlias, parse, similar } from './parse'
import type { CommandDef } from '@/features/console/state/types'

const STOP: CommandDef = {
  name: 'stop',
  aliases: ['desligar'],
  group: 'Energia',
  summary: 'desliga',
  usage: '<seletor...>',
  args: [{ name: 'seletor', required: true, variadic: true, help: '' }],
  options: [
    { name: 'env', value: 'ambiente', help: '' },
    { name: 'except', value: 'seletor', repeatable: true, help: '' },
    { name: 'yes', short: 'y', help: '' },
  ],
  run: async () => undefined,
}

const PROJECT: CommandDef = {
  name: 'project',
  aliases: ['projeto'],
  group: 'Projetos',
  summary: 'projetos',
  subcommands: [
    { name: 'sync', group: 'Projetos', summary: '', args: [{ name: 'projeto', required: true, help: '' }], run: async () => undefined },
    { name: 'list', group: 'Projetos', summary: '', run: async () => undefined },
  ],
}

const COMMANDS = [STOP, PROJECT]

describe('lexer', () => {
  it('separa termos, aspas e comandos', () => {
    expect(tokenize(`stop loja --at "amanhã 07:00"; project sync 'meu projeto'`)).toEqual([
      ['stop', 'loja', '--at', 'amanhã 07:00'],
      ['project', 'sync', 'meu projeto'],
    ])
    expect(tokenize('a "b;c" \\; d')).toEqual([['a', 'b;c', ';', 'd']])
    expect(tokenize('  ;  ; ')).toEqual([])
    expect(() => tokenize('stop "loja')).toThrow(/aspas/)
    expect(quote('meu projeto')).toBe('"meu projeto"')
    expect(quote('loja')).toBe('loja')
  })
})

describe('parse', () => {
  it('nome em português equivale ao canônico', () => {
    const inv = parse(['desligar', 'loja'], COMMANDS)
    expect(inv.path).toEqual(['stop'])
    expect(inv.args).toEqual(['loja'])
  })

  it('opções com =, curtas, repetíveis e globais', () => {
    const inv = parse(['stop', 'all', '--env=staging', '--except', 'blog', '--except', 'loja/db', '-y', '--json'], COMMANDS)
    expect(inv.options).toEqual({ env: 'staging', except: ['blog', 'loja/db'], yes: true, json: true })
  })

  it('comando desconhecido sugere o mais próximo', () => {
    expect(() => parse(['stp', 'loja'], COMMANDS)).toThrow('comando desconhecido: stp — você quis dizer stop?')
  })

  it('opção desconhecida, valor ausente e argumento obrigatório', () => {
    expect(() => parse(['stop', 'loja', '--evn', 'x'], COMMANDS)).toThrow(/opção desconhecida.*--env/)
    expect(() => parse(['stop', 'loja', '--env'], COMMANDS)).toThrow(/exige um valor/)
    expect(() => parse(['stop'], COMMANDS)).toThrow(/argumento obrigatório ausente: <seletor>/)
    expect(() => parse(['project', 'sync'], COMMANDS)).toThrow(/<projeto>/)
    expect(() => parse(['project', 'list', 'x'], COMMANDS)).toThrow(/argumentos demais/)
  })

  it('subcomandos', () => {
    expect(parse(['projeto', 'sync', 'loja'], COMMANDS).path).toEqual(['project', 'sync'])
    expect(() => parse(['project'], COMMANDS)).toThrow(/uso: project <sync\|list>/)
    expect(() => parse(['project', 'synk'], COMMANDS)).toThrow(/subcomando desconhecido.*sync\?/)
    expect(parse(['project', '--help'], COMMANDS).options.help).toBe(true)
  })

  it('apelidos expandem só o primeiro termo e não substituem comandos', () => {
    const aliases = { fimdodia: 'stop all --except infra -y', stop: 'project list' }
    expect(expandAlias(['fimdodia', '--env', 'prod'], COMMANDS, aliases)).toEqual([
      ['stop', 'all', '--except', 'infra', '-y', '--env', 'prod'],
    ])
    expect(expandAlias(['stop', 'loja'], COMMANDS, aliases)).toEqual([['stop', 'loja']])
  })

  it('semelhantes', () => {
    expect(similar('loj', ['loja', 'loja-admin', 'blog'])).toEqual(['loja', 'loja-admin'])
  })
})
