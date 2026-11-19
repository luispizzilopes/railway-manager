// Executa uma linha: `;` em sequência (para no primeiro que falhar), apelidos,
// ajuda e tradução de erros em blocos de saída.

import { ApiError } from '@/shared/api/client'
import { ct } from '@/features/console/lib/i18n'
import { errorMessage } from '@/shared/i18n/errors'
import { helpBlocks } from '@/features/console/lib/help'
import { SyntaxError_, tokenize } from './lexer'
import { expandAlias, findCommand, parse } from './parse'
import type { Block, Ctx } from '@/features/console/state/types'
import { Aborted, CommandError } from '@/features/console/state/types'

/** Linha que levaria um token como argumento: recusada e nunca gravada no histórico. */
export function carriesSecret(line: string): boolean {
  let commands: string[][]
  try {
    commands = tokenize(line)
  } catch {
    return false
  }
  return commands.some((tokens) => {
    const [cmd, sub, ...rest] = tokens.map((t) => t.toLowerCase())
    const isCredential = cmd === 'credential' || cmd === 'credencial'
    const isSet = sub === 'set' || sub === 'definir'
    const positional = rest.filter((t, i) => !t.startsWith('-') && rest[i - 1] !== '--workspace')
    return isCredential && isSet && positional.length > 1
  })
}

export function errorBlock(err: unknown): Block {
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'error', message: ct('m.engine.sessionExpired'), status: 401, code: err.code }
    return { kind: 'error', message: errorMessage(err), status: err.status, code: err.code, details: err.details }
  }
  if (err instanceof CommandError) return { kind: 'error', message: err.message, details: err.details }
  if (err instanceof Aborted) return { kind: 'text', text: ct('m.engine.interrupted'), tone: 'muted' }
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return { kind: 'error', message: ct('m.engine.network', { message: err.message }) }
  }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
}

/** Contexto para uma invocação (o `--json` é por comando). */
export type CtxFactory = (json: boolean) => Ctx

/** Executa a linha e devolve `true` se todos os comandos terminaram bem. */
export async function runLine(line: string, makeCtx: CtxFactory): Promise<boolean> {
  const base = makeCtx(false)
  if (carriesSecret(line)) {
    base.print({
      kind: 'error',
      message: ct('m.engine.secretInLine'),
    })
    return false
  }
  let commands: string[][]
  try {
    commands = tokenize(line)
  } catch (err) {
    base.print({ kind: 'error', message: err instanceof SyntaxError_ ? ct('m.engine.syntax', { message: err.message }) : String(err) })
    return false
  }
  const expanded = commands.flatMap((tokens) => expandAlias(tokens, base.commands, base.aliases))
  for (const tokens of expanded) {
    if (tokens.length === 0) continue
    let ok: boolean
    try {
      const inv = parse(tokens, base.commands, tokens.join(' '))
      const ctx = makeCtx(inv.options.json === true)
      if (inv.options.help) {
        for (const block of helpBlocks(ctx.commands, inv.path)) ctx.print(block)
        ok = true
      } else if (!inv.def.run) {
        throw new CommandError(ct('m.engine.notRunnable', { path: inv.path.join(' ') }))
      } else {
        ok = (await inv.def.run(ctx, inv)) !== false
      }
    } catch (err) {
      base.print(errorBlock(err))
      if (err instanceof ApiError && err.status === 401) base.logout().catch(() => undefined)
      ok = false
    }
    if (!ok) return false
    if (base.signal.aborted) return false
  }
  return true
}

/** Nome canônico do comando de uma linha (para o autocompletar e a ajuda). */
export function commandOf(line: string, ctx: Pick<Ctx, 'commands'>): string | undefined {
  try {
    const [first] = tokenize(line)
    return first && findCommand(ctx.commands, first[0])?.name
  } catch {
    return undefined
  }
}
