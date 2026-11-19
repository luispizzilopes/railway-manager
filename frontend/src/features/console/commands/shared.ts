// Utilitários comuns aos comandos.

import type { OperationDetail, PowerKind } from '@/shared/api/types'
import { formatDateTime } from '@/shared/lib/format'
import { flag } from '@/features/console/engine/parse'
import type { Block, Ctx, Invocation, OptionSource, Tone } from '@/features/console/state/types'
import { ct } from '@/features/console/lib/i18n'
import { Aborted, CommandError } from '@/features/console/state/types'

export const YES: OptionSource = { name: 'yes', short: 'y' }

export function short(id: string): string {
  return id.slice(0, 8)
}

export function when(iso: string | null | undefined): string {
  return formatDateTime(iso)
}

/** Imprime o bloco, ou o valor em JSON com `--json`. */
export function show(ctx: Ctx, value: unknown, ...blocks: Block[]) {
  if (ctx.json) ctx.print({ kind: 'json', value })
  else for (const b of blocks) ctx.print(b)
}

export function note(ctx: Ctx, text: string, tone: Tone = 'muted') {
  if (!ctx.json) ctx.print({ kind: 'text', text, tone })
}

/**
 * Item pelo ID (completo ou prefixo de 4+ caracteres) ou nome exato.
 * Ambíguo ou inexistente → erro com as opções.
 */
export function pick<T>(
  items: T[],
  text: string,
  kind: 'operation' | 'scheduledAction' | 'schedule',
  id: (t: T) => string,
  name?: (t: T) => string,
): T {
  const lower = text.toLowerCase()
  const byName = name ? items.filter((t) => name(t).toLowerCase() === lower) : []
  if (byName.length === 1) return byName[0]
  const byId = lower.length >= 4 ? items.filter((t) => id(t).toLowerCase().startsWith(lower)) : []
  const found = byName.length > 1 ? byName : byId
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    throw new CommandError(
      ct('m.pick.ambiguous', {
        text,
        kinds: ct(`m.pick.kind.${kind}.many`),
        list: found.map((t) => (name ? `${name(t)} (${short(id(t))})` : short(id(t)))).join(', '),
      }),
    )
  }
  const known = items.slice(0, 8).map((t) => (name ? name(t) : short(id(t))))
  throw new CommandError(
    ct('m.pick.none', {
      kind: ct(`m.pick.kind.${kind}.one`),
      text,
      known: known.length ? ct('m.pick.known', { list: known.join(', ') }) : '',
    }),
  )
}

/** Confirmação padrão para ações destrutivas, dispensável com `-y`. */
export async function confirmOrCancel(ctx: Ctx, inv: Invocation, question: string, word?: string): Promise<boolean> {
  if (flag(inv, 'yes')) return true
  const ok = await ctx.confirm(question, word ? { word } : undefined)
  if (!ok) ctx.print({ kind: 'text', text: ct('m.common.cancelled'), tone: 'muted' })
  return ok
}

/** Verbo no infinitivo, no idioma ativo. */
export const verb = (kind: PowerKind): string => ct(`m.verb.${kind}`)

/**
 * Acompanha a operação até o fim, atualizando um bloco de progresso.
 * `Ctrl+C` só para o acompanhamento; a operação continua no backend.
 */
export async function watch(ctx: Ctx, operationId: string, kind: PowerKind, once = false): Promise<OperationDetail | null> {
  const id = ctx.print({ kind: 'progress', operationId, powerKind: kind, status: null, items: [], done: false })
  let detail: OperationDetail | null = null
  try {
    for (;;) {
      detail = await ctx.api.operation(operationId)
      ctx.update(id, {
        kind: 'progress',
        operationId,
        powerKind: detail.operation.kind,
        status: detail.operation.status,
        items: detail.items,
        done: detail.done,
        detached: once && !detail.done,
      })
      if (detail.done || once) break
      await ctx.sleep(ctx.pollMs)
    }
  } catch (err) {
    if (!(err instanceof Aborted)) throw err
    ctx.update(id, {
      kind: 'progress',
      operationId,
      powerKind: kind,
      status: detail?.operation.status ?? null,
      items: detail?.items ?? [],
      done: false,
      detached: true,
    })
    ctx.print({
      kind: 'text',
      tone: 'warn',
      text: ct('m.watch.interrupted', { id: operationId }),
    })
    return null
  }
  if (detail?.done) ctx.invalidate()
  return detail
}

/** `true` se a operação terminou sem falhas. */
export function succeeded(detail: OperationDetail | null): boolean {
  return detail?.operation.status === 'succeeded'
}
