// start / stop / restart, com plano, confirmação, acompanhamento e agendamento pontual.

import { ApiError } from '@/shared/api/client'
import type { ActionTarget, Plan, PowerKind } from '@/shared/api/types'
import { currentLanguage } from '@/shared/i18n'
import { KIND_LABEL } from '@/shared/lib/format'
import { flag, list, str } from '@/features/console/engine/parse'
import { type ResolvedInstance, instanceName, parseSelector, resolveSelectors } from '@/features/console/state/selectors'
import { describeWhen, parseWhen } from '@/features/console/lib/time'
import type { Block, CommandDef, CommandSource, Ctx, Invocation, OptionSource, ArgSource } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'
import { YES, note, short, show, succeeded, verb, watch } from './shared'

const TARGET_OPTIONS: OptionSource[] = [
  { name: 'env', value: 'ambiente', complete: 'environment' },
  { name: 'except', value: 'seletor', repeatable: true, complete: 'selector' },
  { name: 'state', value: 'estado', complete: 'state' },
]

const RUN_OPTIONS: OptionSource[] = [
  { name: 'dry-run' },
  YES,
]

const SCHEDULE_OPTIONS: OptionSource[] = [
  { name: 'at', value: 'quando' },
  { name: 'in', value: 'duração' },
  { name: 'tz', value: 'fuso' },
  { name: 'note', value: 'texto' },
]

const NO_WAIT: OptionSource = { name: 'no-wait' }

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
      throw new CommandError(ct('m.power.planExpired'))
    }
    const existing = err instanceof ApiError ? err.details?.operation_id : undefined
    if (typeof existing === 'string') return existing
    throw err
  }
}

async function confirmPlan(ctx: Ctx, inv: Invocation, question: string): Promise<boolean> {
  if (flag(inv, 'yes')) return true
  const ok = isAll(inv)
    ? await ctx.confirm(ct('m.power.confirmAll', { question, word: ct('m.power.allWord') }), { word: ct('m.power.allWord') })
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
      describe: ct('m.power.dynamicAll', { env: environment ? ` · ${environment}` : '' }),
    }
  }
  if (noExcept && sameEnv && selectors.every((s) => !s.all && !s.service)) {
    const ids = [...new Set(targets.map((t) => t.projectId))]
    const names = [...new Set(targets.map((t) => t.projectName))]
    return {
      target: { type: 'projects', project_ids: ids, environment_name: environment ?? null },
      describe: ct('m.power.dynamicProjects', { names: names.join(', '), env: environment ? ` · ${environment}` : '' }),
    }
  }
  return {
    target: { type: 'instances', instance_ids: targets.map((t) => t.id) },
    describe: ct('m.power.fixed', { count: targets.length }),
  }
}

async function scheduleAction(ctx: Ctx, inv: Invocation, kind: PowerKind): Promise<boolean> {
  if (str(inv, 'state')) throw new CommandError(ct('m.power.stateWithAt'))
  const targets = await resolve(ctx, inv)
  const tz = str(inv, 'tz') ?? (await defaultTimeZone(ctx))
  const now = ctx.now()
  const when = parseWhen({ at: str(inv, 'at'), in: str(inv, 'in'), tz }, now, tz)
  const { target, describe } = actionTarget(inv, targets)
  const description = describeWhen(when.at, when.timeZone, now)
  if (!ctx.json) {
    ctx.print({
      kind: 'table',
      title: ct('m.power.scheduledTitle'),
      columns: [ct('m.power.scheduledCols.action'), ct('m.power.scheduledCols.when'), ct('m.power.scheduledCols.tz'), ct('m.power.scheduledCols.target'), ct('m.power.scheduledCols.instances')],
      rows: [[KIND_LABEL[kind], description, when.timeZone, describe, targets.length]],
    })
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, ct('m.power.notScheduled'))
    return true
  }
  if (!flag(inv, 'yes') && !(await ctx.confirm(ct('m.power.confirmSchedule', { verb: verb(kind), when: description })))) {
    ctx.print({ kind: 'text', text: ct('m.common.cancelled'), tone: 'muted' })
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
    text: ct('m.power.scheduled', { id: short(action.id), kind: KIND_LABEL[kind], label: action.label, when: description }),
  })
  return true
}

async function power(ctx: Ctx, inv: Invocation, kind: PowerKind): Promise<boolean> {
  if (str(inv, 'at') || str(inv, 'in')) return scheduleAction(ctx, inv, kind)
  for (const only of ['tz', 'note']) {
    if (str(inv, only) !== undefined) throw new CommandError(ct('m.power.onlyWithAt', { name: only }))
  }
  const targets = await resolve(ctx, inv)
  const plan = await planFor(
    ctx,
    kind,
    targets.map((t) => t.id),
  )
  const todo = actionable(plan).length
  if (todo === 0) {
    note(ctx, ct('m.power.nothingToRun'), 'info')
    return true
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, ct('m.common.simulation'))
    return true
  }
  if (!(await confirmPlan(ctx, inv, ct('m.power.confirmRun', { verb: verb(kind)[0].toUpperCase() + verb(kind).slice(1), count: todo })))) {
    return false
  }
  const operationId = await executePlan(ctx, plan)
  ctx.invalidate()
  if (flag(inv, 'no-wait')) {
    show(ctx, { operation_id: operationId }, { kind: 'text', text: ct('m.power.opCreated', { id: operationId, short: short(operationId) }) })
    return true
  }
  const detail = await watch(ctx, operationId, kind)
  return detail !== null && succeeded(detail)
}

// ---------- restart ----------

type Outcome = 'restarted' | 'stopFailed' | 'startFailed' | 'skipped'

async function restart(ctx: Ctx, inv: Invocation): Promise<boolean> {
  if (str(inv, 'at') || str(inv, 'in')) {
    throw new CommandError(ct('m.power.restartNoSchedule'))
  }
  const targets = await resolve(ctx, inv)
  const byId = new Map(targets.map((t) => [t.id, t]))
  note(ctx, ct('m.power.step1'), 'info')
  const stopPlan = await planFor(
    ctx,
    'stop',
    targets.map((t) => t.id),
  )
  const outcome = new Map<string, { result: Outcome; reason?: string }>()
  for (const e of stopPlan.entries) {
    if (e.action === 'will_skip') {
      const reason = e.reason_code === 'already_in_desired_state' ? ct('m.power.wasOff') : (e.reason ?? undefined)
      outcome.set(e.instance_id, { result: 'skipped', reason })
    }
  }
  const toStop = actionable(stopPlan)
  if (toStop.length === 0) {
    note(ctx, ct('m.power.nothingToRestart'), 'info')
    return true
  }
  if (flag(inv, 'dry-run')) {
    note(ctx, ct('m.common.simulation'))
    return true
  }
  const question = ct('m.power.confirmRestart', { count: toStop.length })
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
    note(ctx, ct('m.power.restartInterrupted', { command: restartCommand(record) }), 'warn')
    return false
  }
  const down: string[] = []
  for (const item of stopped.items) {
    if (!item.service_instance_id || outcome.has(item.service_instance_id)) continue
    if (item.result === 'succeeded') down.push(item.service_instance_id)
    else outcome.set(item.service_instance_id, { result: 'stopFailed', reason: item.error_message ?? item.result })
  }

  let ok = true
  if (down.length > 0) {
    note(ctx, ct('m.power.step2'), 'info')
    const startPlan = await planFor(ctx, 'start', down)
    for (const e of startPlan.entries) {
      if (e.action === 'will_skip') outcome.set(e.instance_id, { result: 'startFailed', reason: e.reason ?? undefined })
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
            ? { result: 'restarted' }
            : { result: 'startFailed', reason: item.error_message ?? item.result },
        )
      }
    } else {
      ctx.store.remove(RESTART_KEY)
    }
  } else {
    ctx.store.remove(RESTART_KEY)
  }

  const rows = targets.map((t) => {
    const o = outcome.get(t.id) ?? { result: 'startFailed' as Outcome, reason: ct('m.power.noResult') }
    if (o.result !== 'restarted' && o.result !== 'skipped') ok = false
    const tone = o.result === 'restarted' ? 'success' : o.result === 'skipped' ? 'muted' : 'error'
    return [instanceName(byId.get(t.id)!), { text: ct(`m.power.outcome.${o.result}`), tone } as const, o.reason ?? '']
  })
  show(ctx, Object.fromEntries(outcome), {
    kind: 'table',
    title: ct('m.power.restartSummary'),
    columns: [ct('m.power.restartCols.instance'), ct('m.power.restartCols.result'), ct('m.power.restartCols.reason')],
    rows,
  })
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
    text: ct('m.power.restartNotice', {
      when: new Date(record.startedAt).toLocaleString(currentLanguage()),
      names: record.names.join(', '),
    }),
  }
}

// ---------- definições ----------

const SELECTOR_ARG: ArgSource = {
  name: 'seletor',
  required: true,
  variadic: true,
  complete: 'selector',
}

function powerDef(kind: PowerKind, name: string, alias: string): CommandSource {
  return {
    name,
    aliases: [alias],
    group: 'Energia',
    usage: '<seletor...> [opções]',
    args: [SELECTOR_ARG],
    options: [...TARGET_OPTIONS, ...RUN_OPTIONS, NO_WAIT, ...SCHEDULE_OPTIONS],
    examples:
      kind === 'stop'
        ? ['stop loja', 'stop all --except infra', 'stop */worker --env staging --dry-run', 'stop all --at 18:00 -y', 'desligar loja/api@production -y --no-wait']
        : ['start loja@production', 'start all --env production -y', 'start blog --in 2h', 'start all --at "amanhã 07:00" --tz America/Sao_Paulo'],
    run: (ctx, inv) => power(ctx, inv, kind),
  }
}

export const powerCommands: CommandDef[] = defineCommands([
  powerDef('stop', 'stop', 'desligar'),
  powerDef('start', 'start', 'ligar'),
  {
    name: 'restart',
    aliases: ['reiniciar'],
    group: 'Energia',
    usage: '<seletor...> [opções]',
    args: [SELECTOR_ARG],
    options: [
      ...TARGET_OPTIONS,
      ...RUN_OPTIONS,
      { name: 'at', value: 'quando' },
      { name: 'in', value: 'duração' },
    ],
    examples: ['restart loja/api@production', 'restart loja --env staging -y', 'reiniciar */worker --dry-run'],
    run: restart,
  },
])
