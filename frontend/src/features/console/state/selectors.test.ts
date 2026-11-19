import { describe, expect, it } from 'vitest'

import { findProject, instanceName, parseSelector, resolveSelectors } from './selectors'
import { sampleDashboard } from '@/features/console/lib/testing'

const d = sampleDashboard()
const names = (selectors: string[], options = {}) => resolveSelectors(d, selectors, options).map(instanceName)

describe('seletores', () => {
  it('gramática', () => {
    expect(parseSelector('loja/api@production')).toEqual({
      raw: 'loja/api@production',
      all: false,
      project: 'loja',
      service: 'api',
      environment: 'production',
    })
    expect(parseSelector('ALL@staging')).toMatchObject({ all: true, environment: 'staging' })
    expect(() => parseSelector('all/api')).toThrow(/\*\/api/)
    expect(() => parseSelector('loja/')).toThrow(/serviço vazio/)
  })

  it('table de casos', () => {
    const cases: [string[], object, string[]][] = [
      [['loja@staging'], {}, ['loja/api@staging', 'loja/worker@staging']],
      [['loja/api'], {}, ['loja/api@production', 'loja/api@staging']],
      [['LOJA/API@Production'], {}, ['loja/api@production']],
      [['*/worker'], { env: 'staging' }, ['loja/worker@staging']],
      [['*/worker'], {}, ['loja/worker@production', 'loja/worker@staging', 'blog/worker@production']],
      [['loja*'], { env: 'production' }, ['loja/api@production', 'loja/worker@production', 'loja/db@production', 'loja-admin/web@production']],
      [['all'], { state: 'stopped' }, ['loja/worker@production', 'loja/worker@staging', 'blog/web@production']],
      [['loja/api', 'loja/api@staging'], {}, ['loja/api@production', 'loja/api@staging']],
      [['p-blog'], {}, ['blog/web@production', 'blog/worker@production']],
      [['loja/api@production'], {}, ['loja/api@production']],
    ]
    for (const [selectors, options, expected] of cases) {
      expect(names(selectors, options), selectors.join(' ')).toEqual(expected)
    }
  })

  it('exclusões', () => {
    expect(names(['all'], { except: ['blog', 'loja/db'] })).toEqual([
      'loja/api@production',
      'loja/worker@production',
      'loja/api@staging',
      'loja/worker@staging',
      'loja-admin/web@production',
    ])
  })

  it('sem correspondência sugere semelhantes e nada é resolvido', () => {
    expect(() => names(['loj'])).toThrow("nenhum projeto 'loj' — semelhantes: loja, loja-admin")
    expect(() => names(['loja/apu'])).toThrow(/nenhum serviço 'apu' em loja — semelhantes: api/)
    expect(() => names(['loja@prod'])).toThrow(/nenhum ambiente 'prod'.*production/)
    expect(() => names(['all'], { state: 'ligado' })).toThrow(/estado inválido/)
    expect(() => names(['loja'], { except: ['loja'] })).toThrow(/nenhuma instância restou/)
    expect(() => names([])).toThrow(/ao menos um seletor/)
  })

  it('projeto único', () => {
    expect(findProject(d, 'Loja').project.id).toBe('p-loja')
    expect(() => findProject(d, 'loja*')).toThrow(/vários projetos/)
  })
})
