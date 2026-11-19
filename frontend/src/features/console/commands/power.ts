// start / stop / restart, com plano, confirmação, acompanhamento e agendamento pontual.

import { ApiError } from '@/shared/api/client'
import type { ActionTarget, Plan, PowerKind } from '@/shared/api/types'
import { KIND_LABEL } from '@/shared/lib/format'
import { flag, list, str } from '@/features/console/engine/parse'
import { type ResolvedInstance, instanceName, parseSelector, resolveSelectors } from '@/features/console/state/selectors'
import { describeWhen, parseWhen } from '@/features/console/lib/time'
import type { Block, CommandDef, Ctx, Invocation, OptionDef } from '@/features/console/state/types'
import { CommandError } from '@/features/console/state/types'
import { VERB, YES, note, short, show, succeeded, watch } from './shared'

const TARGET_OPTIONS: OptionDef[] = [
  { name: 'env', value: 'ambiente', help: 'restringe todos os seletores a um ambiente', complete: 'environment' },
  { name: 'except', value: 'seletor', repeatable: true, help: 'remove instâncias do alvo', complete: 'selector' },
  { name: 'state', value: 'estado', help: 'filtra pelo estado observado (running, stopped, …)', complete: 'state' },
]

const RUN_OPTIONS: OptionDef[] = [
  { name: 'dry-run', help: 'só mostra o plano; nada é executado' },
  YES,
]

const SCHEDULE_OPTIONS: OptionDef[] = [
  { name: 'at', value: 'quando', help: 'agenda para um instante: HH:MM, AAAA-MM-DD HH:MM, DD/MM HH:MM, "amanhã HH:MM"' },
  { name: 'in', value: 'duração', help: 'agenda para daqui a uma duração: 30m, 2h, 1h30m' },
  { name: 'tz', value: 'fuso', help: 'fuso IANA de --at', default: 'fuso padrão das agendas' },
  { name: 'note', value: 'texto', help: 'observação da ação agendada' },
]

const NO_WAIT: OptionDef = { name: 'no-wait', help: 'não acompanha a operação; mostra só o identificador' }

const RESTART_KEY = 'restart'

export interface RestartRecord {
  stopOperationId: string
  instanceIds: string[]
  names: string[]
  startedAt: string
}

function selectOptions(inv: Invocation) {
  return { env: str(inv, 'env'), state: str(inv, 'state'), except: list(inv, 'except') }
}

function isAll(inv: Invocation): boolean {
  return inv.args.some((a) => parseSelector(a).all)
}

async function resolve(ctx: Ctx, inv: Invocation): Promise<ResolvedInstance[]> {
  const dashboard = await ctx.dashboard(true)
  return resolveSelectors(dashboard, inv.args, selectOptions(inv))
}

function actionable(plan: Plan) {
  return plan.entries.filter((e) => e.action !== 'will_skip')
}

async function planFor(ctx: Ctx, kind: PowerKind, ids: string[]): Promise<Plan> {
  const plan = await ctx.api.plan(kind, { type: 'instances', instance_ids: ids })
  show(ctx, plan, { kind: 'plan', plan })
  return plan
}

/** Executa o plano; plano expirado vira erro claro, plano já usado devolve a operação. */
async function executePlan(ctx: Ctx, plan: Plan): Promise<string> {
  try {
    return (await ctx.api.execute(plan.plan_id)).operation_id
  } catch (err) {
    if (err instanceof ApiError && err.status === 410) {
      throw new CommandError('o plano expirou antes da confirmação — repita o comando para gerar um novo plano')
    }
    const existing = err instanceof ApiError ? err.details?.operation_id : undefined
    if (typeof existing === 'string') return existing
    throw err
  }
}

async function confirmPlan(ctx: Ctx, inv: Invocation, question: string): Promise<boolean> {
  if (flag(inv, 'yes')) return true
  const ok = isAll(inv)
    ? await ctx.confirm(`${question} Isto afeta TODOS os projetos: digite "tudo" para confirmar.`, { word: 'tudo' })
    : await ctx.confirm(question)
  if (!ok) ctx.print({ kind: 'text', text: 'cancelado', tone: 'muted' })
  return ok
}

async function defaultTimeZone(ctx: Ctx): Promise<string> {
  return (await ctx.api.scheduledActions('pending', 1, 1)).default_timezone
}

/** Alvo da ação agendada: dinâmico só para `all`; projetos inteiros; ou instâncias fixas. */
export function actionTarget(inv: Invocation, targets: ResolvedInstance[]): { target: ActionTarget; describe: string } {
  const selectors = inv.args.map(parseSelector)
  const envs = new Set(selectors.map((s) => s.environment?.toLowerCase()))
  const env = str(inv, 'env')
  const environment = env ?? (envs.size === 1 ? selectors[0].environment : undefined)
  const sameEnv = env !== undefined || envs.size === 1
  const noExcept = list(inv, 'except').length === 0
  if (noExcept && sameEnv && selectors.every((s) => s.all)) {
    return {
      target: { type: 'all', environment_name: environment ?? null },
      describe: `todos os projetos${environment ? ` · ${environment}` : ''} (dinâmico: inclui projetos importados depois)`,
    }
  }
  if (noExcept && sameEnv && selectors.every((s) => !s.all && !s.service)) {
    const ids = [...new Set(targets.map((t) => t.projectId))]
    const names = [...new Set(targets.map((t) => t.projectName))]
    return {
      target: { type: 'projects', project_ids: ids, environment_name: environment ?? null },
      describe: `projetos ${names.join(', ')}${environment ? ` · ${environment}` : ''} (inclui instâncias importadas depois)`,
    }
  }
  return {
    target: { type: 'instances', instance_ids: targets.map((t) => t.id) },
    describe: `${targets.length} instância(s) fixas`,
  }
}

async function scheduleAction(ctx: Ctx, inv: Invocation, kind: PowerKind): Promise<boolean> {
  if (str(inv, 'state')) throw new CommandError('a opção --state não pode ser usada com --at/--in: o estado só é conhecido na hora')
  const targets = await resolve(ctx, inv)
  const tz = str(inv, 'tz') ?? (await defaultTimeZone(ctx))
  const now = ctx.now()
  const when = parseWhen({ at: str(inv, 'at'), in: str(inv, 'in'), tz }, now, tz)
  const { target, describe } = actionTarget(inv, targets)
  const description = describeWhen(when.at, when.timeZone, now)
  if (!ctx.json) {
    ctx.print({
      kind: 'table',
      title: 'Ação agendada',
      columns: ['Ação', 'Quando', 'Fuso', 'Alvo', 'Instâncias hoje'],
      rows: [[KIND_LABEL[kind], description, when.timeZone, describe, targets.length]],
    })
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, 'simulação: nada foi agendado')
    return true
  }
  if (!flag(inv, 'yes') && !(await ctx.confirm(`Agendar ${VERB[kind]} para ${description}?`))) {
    ctx.print({ kind: 'text', text: 'cancelado', tone: 'muted' })
    return false
  }
  const action = await ctx.api.createScheduledAction({
    kind,
    run_at: when.at.toISOString(),
    target,
    note: str(inv, 'note') ?? null,
  })
  ctx.invalidate()
  show(ctx, action, {
    kind: 'text',
    tone: 'success',
    text: `ação agendada ${short(action.id)} criada: ${KIND_LABEL[kind]} · ${action.label} · ${description}\ncancele com: at cancel ${short(action.id)}`,
  })
  return true
}

async function power(ctx: Ctx, inv: Invocation, kind: PowerKind): Promise<boolean> {
  if (str(inv, 'at') || str(inv, 'in')) return scheduleAction(ctx, inv, kind)
  for (const only of ['tz', 'note']) {
    if (str(inv, only) !== undefined) throw new CommandError(`--${only} só vale junto com --at ou --in`)
  }
  const targets = await resolve(ctx, inv)
  const plan = await planFor(
    ctx,
    kind,
    targets.map((t) => t.id),
  )
  const todo = actionable(plan).length
  if (todo === 0) {
    note(ctx, 'nada a executar: todas as instâncias foram ignoradas', 'info')
    return true
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, 'simulação: nada foi executado')
    return true
  }
  if (!(await confirmPlan(ctx, inv, `${VERB[kind][0].toUpperCase()}${VERB[kind].slice(1)} ${todo} instância(s)?`))) {
    return false
  }
  const operationId = await executePlan(ctx, plan)
  ctx.invalidate()
  if (flag(inv, 'no-wait')) {
    show(ctx, { operation_id: operationId }, { kind: 'text', text: `operação ${operationId} criada — acompanhe com: op ${short(operationId)}` })
    return true
  }
  const detail = await watch(ctx, operationId, kind)
  return detail !== null && succeeded(detail)
}

// ---------- restart ----------

type Outcome = 'reiniciada' | 'falhou ao desligar' | 'falhou ao ligar' | 'ignorada'

async function restart(ctx: Ctx, inv: Invocation): Promise<boolean> {
  if (str(inv, 'at') || str(inv, 'in')) {
    throw new CommandError('restart não pode ser agendado: agende stop e start separadamente')
  }
  const targets = await resolve(ctx, inv)
  const byId = new Map(targets.map((t) => [t.id, t]))
  note(ctx, 'etapa 1/2 — desligar', 'info')
  const stopPlan = await planFor(
    ctx,
    'stop',
    targets.map((t) => t.id),
  )
  const outcome = new Map<string, { result: Outcome; reason?: string }>()
  for (const e of stopPlan.entries) {
    if (e.action === 'will_skip') {
      const reason = e.reason_code === 'already_in_desired_state' ? 'não estava ligada' : (e.reason ?? undefined)
      outcome.set(e.instance_id, { result: 'ignorada', reason })
    }
  }
  const toStop = actionable(stopPlan)
  if (toStop.length === 0) {
    note(ctx, 'nada a reiniciar: nenhuma instância do alvo está ligada', 'info')
    return true
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, 'simulação: nada foi executado')
    return true
  }
  const question = `Reiniciar ${toStop.length} instância(s)? Elas ficarão fora do ar até a etapa de ligar terminar.`
  if (!(await confirmPlan(ctx, inv, question))) return false

  const stopId = await executePlan(ctx, stopPlan)
  const record: RestartRecord = {
    stopOperationId: stopId,
    instanceIds: toStop.map((e) => e.instance_id),
    names: toStop.map((e) => `${e.project_name}/${e.service_name}@${e.environment_name}`),
    startedAt: ctx.now().toISOString(),
  }
  ctx.store.set(RESTART_KEY, record)
  ctx.invalidate()
  const stopped = await watch(ctx, stopId, 'stop')
  if (!stopped) {
    ctx.store.remove(RESTART_KEY)
    note(ctx, `reinício interrompido: as instâncias desligadas continuam desligadas — para ligá-las: ${restartCommand(record)}`, 'warn')
    return false
  }
  const down: string[] = []
  for (const item of stopped.items) {
    if (!item.service_instance_id || outcome.has(item.service_instance_id)) continue
    if (item.result === 'succeeded') down.push(item.service_instance_id)
    else outcome.set(item.service_instance_id, { result: 'falhou ao desligar', reason: item.error_message ?? item.result })
  }

  let ok = true
  if (down.length > 0) {
    note(ctx, 'etapa 2/2 — ligar', 'info')
    const startPlan = await planFor(ctx, 'start', down)
    for (const e of startPlan.entries) {
      if (e.action === 'will_skip') outcome.set(e.instance_id, { result: 'falhou ao ligar', reason: e.reason ?? undefined })
    }
    if (actionable(startPlan).length > 0) {
      const startId = await executePlan(ctx, startPlan)
      ctx.store.remove(RESTART_KEY)
      const started = await watch(ctx, startId, 'start')
      if (!started) return false
      for (const item of started.items) {
        if (!item.service_instance_id || outcome.has(item.service_instance_id)) continue
        outcome.set(
          item.service_instance_id,
          item.result === 'succeeded'
            ? { result: 'reiniciada' }
            : { result: 'falhou ao ligar', reason: item.error_message ?? item.result },
        )
      }
    } else {
      ctx.store.remove(RESTART_KEY)
    }
  } else {
    ctx.store.remove(RESTART_KEY)
  }

  const rows = targets.map((t) => {
    const o = outcome.get(t.id) ?? { result: 'falhou ao ligar' as Outcome, reason: 'sem resultado' }
    if (o.result !== 'reiniciada' && o.result !== 'ignorada') ok = false
    const tone = o.result === 'reiniciada' ? 'success' : o.result === 'ignorada' ? 'muted' : 'error'
    return [instanceName(byId.get(t.id)!), { text: o.result, tone } as const, o.reason ?? '']
  })
  show(ctx, Object.fromEntries(outcome), { kind: 'table', title: 'Resumo do reinício', columns: ['Instância', 'Resultado', 'Motivo'], rows })
  return ok
}

export function restartCommand(record: RestartRecord): string {
  return `start ${record.instanceIds.join(' ')} -y`
}

/** Reinício que ficou entre as etapas (página recarregada/fechada). */
export function peekInterruptedRestart(ctx: Pick<Ctx, 'store'>): RestartRecord | null {
  const record = ctx.store.get<RestartRecord | null>(RESTART_KEY, null)
  return record && Array.isArray(record.instanceIds) && record.instanceIds.length > 0 ? record : null
}

export function clearInterruptedRestart(ctx: Pick<Ctx, 'store'>) {
  ctx.store.remove(RESTART_KEY)
}

export function restartNotice(record: RestartRecord): Block {
  return {
    kind: 'text',
    tone: 'warn',
    text:
      `reinício interrompido (iniciado em ${new Date(record.startedAt).toLocaleString('pt-BR')}): ` +
      `${record.names.join(', ')} podem ter ficado desligadas. O comando para ligá-las está pronto abaixo — pressione Enter.`,
  }
}

// ---------- definições ----------

const SELECTOR_ARG = {
  name: 'seletor',
  required: true,
  variadic: true,
  help: 'all, projeto, projeto@ambiente, projeto/serviço, projeto/serviço@ambiente; aceita * e IDs',
  complete: 'selector' as const,
}

function powerDef(kind: PowerKind, name: string, alias: string): CommandDef {
  const verb = VERB[kind]
  return {
    name,
    aliases: [alias],
    group: 'Energia',
    summary: kind === 'stop' ? 'desliga instâncias (interrompe os deployments ativos)' : 'liga instâncias (reaproveita o último deployment)',
    usage: '<seletor...> [opções]',
    args: [SELECTOR_ARG],
    options: [...TARGET_OPTIONS, ...RUN_OPTIONS, NO_WAIT, ...SCHEDULE_OPTIONS],
    details:
      `Gera um plano no servidor, mostra o que será feito e pede confirmação antes de ${verb}. ` +
      'Com o seletor all, a confirmação exige digitar "tudo". Com --at/--in, cria uma ação agendada ' +
      'em vez de executar agora (alvo all é dinâmico; projetos inteiros incluem instâncias novas; o resto fica fixo).',
    examples:
      kind === 'stop'
        ? ['stop loja', 'stop all --except infra', 'stop */worker --env staging --dry-run', 'stop all --at 18:00 -y', 'desligar loja/api@production -y --no-wait']
        : ['start loja@production', 'start all --env production -y', 'start blog --in 2h', 'start all --at "amanhã 07:00" --tz America/Sao_Paulo'],
    run: (ctx, inv) => power(ctx, inv, kind),
  }
}

export const powerCommands: CommandDef[] = [
  powerDef('stop', 'stop', 'desligar'),
  powerDef('start', 'start', 'ligar'),
  {
    name: 'restart',
    aliases: ['reiniciar'],
    group: 'Energia',
    summary: 'reinicia instâncias: desliga e, ao terminar, liga as que desligaram',
    usage: '<seletor...> [opções]',
    args: [SELECTOR_ARG],
    options: [
      ...TARGET_OPTIONS,
      ...RUN_OPTIONS,
      { name: 'at', value: 'quando', help: 'não suportado: o reinício não pode ser agendado' },
      { name: 'in', value: 'duração', help: 'não suportado: o reinício não pode ser agendado' },
    ],
    details:
      'Duas operações no histórico (desligar, depois iniciar). Instâncias que não estavam ligadas não são ligadas. ' +
      'Se o console for fechado entre as etapas, as instâncias ficam desligadas e, ao reabrir, o console mostra o comando para ligá-las.',
    examples: ['restart loja/api@production', 'restart loja --env staging -y', 'reiniciar */worker --dry-run'],
    run: restart,
  },
]
