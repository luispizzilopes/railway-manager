// Heurística para achar texto de usuário escrito direto no código (JSX, atributos de texto e toasts).

const TEXT_PROPS = 'placeholder|title|aria-label|alt|label|description|hint|emptyText'

/** Textos que não se traduzem: nome do produto e atalhos de teclado. */
const ALLOWED = new Set(['Railway', 'Manager', 'Ctrl K', 'Ctrl+K', 'sáb', 'diário', 'úteis', 'amanhã', 'Português'])

export function findLiterals(source: string, jsx = true): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const found: string[] = []
  // Texto entre tags: `>texto<`, sem expressões; ignora `=>` e genéricos.
  for (const m of jsx ? code.matchAll(/(?<![=-])>([^<>{}=;()&|]*?)</g) : []) {
    const text = m[1].trim()
    if (/\p{L}{2}/u.test(text) && !ALLOWED.has(text)) found.push(text.slice(0, 40))
  }
  // Atributos de texto com string literal.
  for (const m of code.matchAll(new RegExp(`\\b(?:${TEXT_PROPS})=(?:"([^"]*)"|\\{'([^']*)'\\})`, 'g'))) {
    const text = m[1] ?? m[2]
    if (/\p{L}{2}/u.test(text)) found.push(`${m[0].slice(0, 40)}`)
  }
  // Strings com letras acentuadas do português (mensagens fora do JSX); palavras aceitas como entrada ficam em ALLOWED.
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const text = m[2]
    const lineStart = code.lastIndexOf('\n', m.index) + 1
    const line = code.slice(lineStart, code.indexOf('\n', m.index) === -1 ? undefined : code.indexOf('\n', m.index))
    // Gramática dos comandos (uso, grupo, exemplos, nomes) não é texto de interface.
    if (/\b(usage|group|examples|aliases|name|value)\s*:|--[a-z]/.test(line) || /^\s*['"`].*['"`],?\s*$/.test(line) && !/\s/.test(text)) continue
    if (/[áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ]/.test(text) && !ALLOWED.has(text) && !/^[\w-]+$/.test(text)) found.push(text.slice(0, 40))
  }
  // Toasts com texto literal.
  for (const m of code.matchAll(/toast\.\w+\(\s*['"`]([^'"`]*)/g)) {
    if (/\p{L}{2}/u.test(m[1])) found.push(`toast: ${m[1].slice(0, 40)}`)
  }
  return found
}
