// Divide uma linha em comandos (`;`) e cada comando em termos, respeitando aspas.

export class SyntaxError_ extends Error {}

/** Termos de cada comando da linha. Aspas simples ou duplas agrupam; `\` escapa. */
export function tokenize(line: string): string[][] {
  const commands: string[][] = []
  let tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  const endToken = () => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }
  const endCommand = () => {
    endToken()
    if (tokens.length > 0) commands.push(tokens)
    tokens = []
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && i + 1 < line.length) current += line[++i]
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
    } else if (c === '\\' && i + 1 < line.length) {
      current += line[++i]
      started = true
    } else if (c === ';') {
      endCommand()
    } else if (/\s/.test(c)) {
      endToken()
    } else {
      current += c
      started = true
    }
  }
  if (quote) throw new SyntaxError_(`aspas ${quote} sem fechamento`)
  endCommand()
  return commands
}

/** Inverso de `tokenize` para um comando: põe aspas onde for preciso. */
export function quote(token: string): string {
  if (token !== '' && !/[\s;"'\\]/.test(token)) return token
  return `"${token.replace(/["\\]/g, (c) => `\\${c}`)}"`
}
