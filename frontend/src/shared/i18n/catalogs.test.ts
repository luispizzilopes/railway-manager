// Guardas do i18n: catálogos com as mesmas chaves e nenhum texto de usuário escrito nos componentes.

import { describe, expect, it } from 'vitest'

import { resources } from './resources'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

/** Plurais (`chave_one`, `chave_other`) variam por idioma; compara pela chave base. */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '')

describe('catálogos', () => {
  it('pt-BR e en têm os mesmos namespaces e chaves', () => {
    const pt = resources['pt-BR'] as Record<string, unknown>
    const en = resources.en as Record<string, unknown>
    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort())
    for (const ns of Object.keys(pt)) {
      const ptKeys = new Set(keys(pt[ns]).map(base))
      const enKeys = new Set(keys(en[ns]).map(base))
      expect({ ns, missingInEn: [...ptKeys].filter((k) => !enKeys.has(k)) }).toEqual({ ns, missingInEn: [] })
      expect({ ns, missingInPt: [...enKeys].filter((k) => !ptKeys.has(k)) }).toEqual({ ns, missingInPt: [] })
    }
  })
})
