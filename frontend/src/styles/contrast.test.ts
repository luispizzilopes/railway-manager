// Garante contraste mínimo WCAG AA nos pares semânticos de cada tema, lendo os próprios tokens.

/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

const THEMES = { claro: block(':root[data-theme=\'light\']'), escuro: block(':root[data-theme=\'dark\']') }

/** oklch(L C H) → luminância relativa sRGB (WCAG). */
function luminance(value: string): number {
  const m = value.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) throw new Error(`cor não suportada: ${value}`)
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180]
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s]
  const [r, g, bl] = lin.map((c) => Math.min(1, Math.max(0, c)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl
}

function ratio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// [texto, fundo, mínimo]: 4.5 para texto normal.
const PAIRS: [string, string, number][] = [
  ['--text', '--bg', 4.5],
  ['--text', '--surface', 4.5],
  ['--text-2', '--surface', 4.5],
  ['--text-3', '--surface', 4.5],
  ['--text-3', '--bg', 4.5],
  ['--text-3', '--surface-sunken', 4.5],
  ['--accent-text', '--surface', 4.5],
  ['--accent-fg', '--accent', 4.5],
  ['--ok', '--surface', 4.5],
  ['--warn', '--surface', 4.5],
  ['--fail', '--surface', 4.5],
  ['--info', '--surface', 4.5],
  ['--idle', '--surface', 4.5],
  ['--text', '--sidebar', 4.5],
  ['--text-2', '--sidebar', 4.5],
]

describe('contraste dos tokens', () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: ${fg} sobre ${bg} ≥ ${min}`, () => {
        expect(ratio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min)
      })
    }
  }
})
