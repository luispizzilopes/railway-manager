// Falha se houver texto de usuário escrito direto em componentes (tudo deve vir dos catálogos).

import { describe, expect, it } from 'vitest'

import { findLiterals } from './literals'

const files = import.meta.glob(['/src/**/*.tsx', '/src/**/*.ts', '!/src/**/*.test.*', '!/src/test/**', '!/src/shared/i18n/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Arquivos sem texto de usuário que a heurística confunde (ex.: formas SVG). */
const EXEMPT = [
  'shared/ui/StatusBadge/StatusBadge.tsx',
  // Falsos positivos da heurística (código TSX com `>` e `<` em expressões) e a API simulada dos testes.
  'features/console/components/output.tsx',
  'features/console/state/types.ts',
  'features/console/lib/testing.ts',
]


describe('texto fixo', () => {
  it('detecta literais de exemplo', () => {
    expect(findLiterals('<p>Olá mundo</p>')).toHaveLength(1)
    expect(findLiterals('<input placeholder="Buscar" />')).toHaveLength(1)
    expect(findLiterals("toast.error('Falhou')")).toHaveLength(1)
    expect(findLiterals('<p>{t("a")}</p>')).toHaveLength(0)
    expect(findLiterals('const f = (a: number) => a > 1 ? 1 : 0')).toHaveLength(0)
  })

  it('os componentes não têm texto de usuário fora dos catálogos', () => {
    const offenders = Object.entries(files)
      .filter(([path]) => !EXEMPT.includes(path.replace('/src/', '')))
      .map(([path, source]) => ({ path, found: findLiterals(source, path.endsWith('.tsx')) }))
      .filter((f) => f.found.length > 0)
    expect(offenders.map((o) => `${o.path}: ${o.found.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
