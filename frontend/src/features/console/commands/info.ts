// Consultas: status, refresh, ops, op, history e ações agendadas (at).

import type { HistoryFilters, ScheduledAction, ScheduledActionStatus } from '@/shared/api/types'
import { errorMessage } from '@/shared/i18n/errors'
import { KIND_LABEL, RESULT_LABEL, STATUS_LABEL } from '@/shared/lib/format'
import { flag, int, str } from '@/features/console/engine/parse'
import { findProject, flatten, resolveSelectors } from '@/features/console/state/selectors'
import { describeWhen } from '@/features/console/lib/time'
import type { Cell, CommandDef, Ctx, Invocation } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'
import { YES, confirmOrCancel, note, pick, short, show, succeeded, watch, when } from './shared'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------- status / refresh ----------

async function status(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  const filtered = inv.args.length > 0 || str(inv, 'env') || str(inv, 'state')
  const instances = filtered
    ? resolveSelectors(dashboard, inv.args.length ? inv.args : ['all'], { env: str(inv, 'env'), state: str(inv, 'state') })
    : flatten(dashboard)
  const next = new Map(dashboard.projects.map((p) => [p.project.id, p.next_action]))
  if (ctx.json) {
    ctx.print({ kind: 'json', value: filtered ? instances : dashboard })
    return
  }
  if (!filtered) {
    const i = dashboard.indicators
    ctx.print({
      kind: 'text',
      text: ct('m.info.summary', { projects: i.projects, instances: i.instances, running: i.running, sleeping: i.sleeping, stopped: i.stopped, failed: i.failed, other: i.other }),
    })
    for (const a of dashboard.alerts) ctx.print({ kind: 'text', tone: 'warn', text: `⚠ ${a.message}` })
    if (!dashboard.integration_ready) note(ctx, ct('m.info.notConfigured'), 'warn')
  }
  if (instances.length === 0) {
    note(ctx, ct('m.info.noInstances'))
    return
  }
  ctx.print({
    kind: 'table',
    columns: [ct('m.info.col.project'), ct('m.info.col.service'), ct('m.info.col.environment'), ct('m.info.col.state'), ct('m.info.col.nextAction'), ct('m.info.col.id')],
    rows: instances.map((i) => {
      const n = next.get(i.projectId)
      return [
        i.projectName,
        i.service + (i.busy ? ct('m.info.busy') : ''),
        i.environment,
        { state: i.state },
        n ? `${KIND_LABEL[n.action]} ${when(n.at)} (${n.schedule_name})` : '',
        { id: i.id },
      ]
    }),
  })
}

async function refresh(ctx: Ctx) {
  const { report } = await ctx.api.refresh()
  ctx.invalidate()
  show(ctx, report, {
    kind: 'text',
    tone: report.failed ? 'warn' : 'success',
    text: ct('m.info.refreshed', { refreshed: report.refreshed, notFound: report.not_found, failed: report.failed }),
  })
}

// ---------- operações ----------

async function ops(ctx: Ctx, inv: Invocation) {
  const recent = (await ctx.dashboard(true)).recent_operations.slice(0, int(inv, 'limit', 10))
  show(ctx, recent, {
    kind: 'table',
    columns: [ct('m.info.ops.col.id'), ct('m.info.ops.col.kind'), ct('m.info.ops.col.trigger'), ct('m.info.ops.col.status'), ct('m.info.ops.col.items'), ct('m.info.ops.col.projects'), ct('m.info.ops.col.created')],
    rows: recent.map((s) => [
      { id: s.operation.id },
      KIND_LABEL[s.operation.kind],
      s.operation.trigger,
      STATUS_LABEL[s.operation.status],
      ct('m.info.ops.items', { ok: s.succeeded, failed: s.failed, skipped: s.skipped }) + (s.active ? ct('m.info.ops.active', { count: s.active }) : ''),
      s.projects.join(', '),
      when(s.operation.created_at),
    ]),
  })
  if (recent.length === 0) note(ctx, ct('m.info.ops.none'))
}

async function op(ctx: Ctx, inv: Invocation) {
  let id = inv.args[0]
  if (!UUID.test(id)) {
    const recent = (await ctx.dashboard(true)).recent_operations.map((s) => s.operation)
    id = pick(recent, id, 'operation', (o) => o.id).id
  }
  if (ctx.json) {
    ctx.print({ kind: 'json', value: await ctx.api.operation(id) })
    return
  }
  const first = await ctx.api.operation(id)
  const detail = await watch(ctx, id, first.operation.kind, flag(inv, 'no-wait'))
  return detail === null ? false : !detail.done || succeeded(detail)
}

// ---------- histórico ----------

const KINDS = ['start', 'stop']
const RESULTS = Object.keys(RESULT_LABEL)
const TRIGGERS = ['manual', 'schedule', 'scheduled_action']

function oneOf(name: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new CommandError(ct('m.info.invalidOption', { name, value, allowed: allowed.join(', ') }))
  }
  return value
}

async function serviceId(ctx: Ctx, text: string, projectIds: string[]): Promise<string> {
  if (UUID.test(text)) return text
  const found = new Set<string>()
  for (const id of projectIds) {
    for (const v of (await ctx.api.instances(id)).instances) {
      if (v.service.name.toLowerCase() === text.toLowerCase()) found.add(v.service.railway_service_id)
    }
  }
  if (found.size === 0) throw new CommandError(ct('m.info.noService', { text }))
  if (found.size > 1) throw new CommandError(ct('m.info.serviceAmbiguous', { text }))
  return [...found][0]
}

async function history(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard()
  const filters: HistoryFilters & { per_page?: number } = {
    environment: str(inv, 'env'),
    kind: oneOf('kind', str(inv, 'kind'), KINDS),
    result: oneOf('result', str(inv, 'result'), RESULTS),
    trigger: oneOf('trigger', str(inv, 'trigger'), TRIGGERS),
    from: str(inv, 'from'),
    to: str(inv, 'to'),
    page: int(inv, 'page', 1),
  }
  const projectText = str(inv, 'project')
  let projectIds = dashboard.projects.map((p) => p.project.id)
  if (projectText) {
    if (UUID.test(projectText) && !dashboard.projects.some((p) => p.project.id === projectText)) {
      filters.project = projectText
    } else {
      const p = findProject(dashboard, projectText).project
      filters.project = p.railway_project_id
      projectIds = [p.id]
    }
  }
  const serviceText = str(inv, 'service')
  if (serviceText) filters.service = await serviceId(ctx, serviceText, projectIds)
  const limit = int(inv, 'limit', 20)
  const page = await ctx.api.history({ ...filters, per_page: limit } as HistoryFilters)
  show(ctx, page, {
    kind: 'table',
    title: ct('m.info.history.title', { page: page.page, pages: Math.max(1, Math.ceil(page.total / page.per_page)), total: page.total }),
    columns: [
      ct('m.info.history.col.when'),
      ct('m.info.history.col.kind'),
      ct('m.info.history.col.project'),
      ct('m.info.history.col.service'),
      ct('m.info.history.col.environment'),
      ct('m.info.history.col.result'),
      ct('m.info.history.col.trigger'),
      ct('m.info.history.col.message'),
    ],
    rows: page.items.map((h) => [
      when(h.created_at),
      KIND_LABEL[h.kind],
      h.item.label.project_name,
      h.item.label.service_name,
      h.item.label.environment_name,
      { result: h.item.result },
      h.trigger === 'schedule'
        ? ct('m.info.history.schedule', { name: h.schedule_name ?? '' })
        : h.trigger === 'scheduled_action'
          ? ct('m.info.history.action', { label: h.scheduled_action_label ?? '' })
          : h.requested_by,
      h.item.error_message ?? '',
    ]),
  })
}

// ---------- ações agendadas ----------

const ACTION_STATUSES: ScheduledActionStatus[] = ['pending', 'processing', 'executed', 'late', 'skipped', 'missed', 'failed', 'cancelled']
const actionStatus = (status: ScheduledActionStatus) => ct(`m.info.actionStatus.${status}`)

function actionRow(ctx: Ctx, a: ScheduledAction, timeZone: string): Cell[] {
  const tone = a.status === 'failed' || a.status === 'missed' ? 'error' : a.status === 'pending' ? 'info' : 'muted'
  return [
    { id: a.id },
    KIND_LABEL[a.kind],
    a.status === 'pending' ? describeWhen(new Date(a.run_at), timeZone, ctx.now()) : when(a.run_at),
    a.label,
    { text: actionStatus(a.status) + (a.message ? ` — ${a.message}` : ''), tone },
    a.operation_id ? { id: a.operation_id } : '',
    a.note ?? '',
  ]
}

const actionColumns = () => [
  ct('m.info.action.col.id'),
  ct('m.info.action.col.action'),
  ct('m.info.action.col.when'),
  ct('m.info.action.col.target'),
  ct('m.info.action.col.status'),
  ct('m.info.action.col.operation'),
  ct('m.info.action.col.note'),
]

async function allActions(ctx: Ctx) {
  return ctx.api.scheduledActions(undefined, 1, 200)
}

async function atList(ctx: Ctx, inv: Invocation) {
  const raw = str(inv, 'status')
  const statuses: string[] = ACTION_STATUSES
  const status = flag(inv, 'all') ? undefined : ((oneOf('status', raw, statuses) ?? 'pending') as ScheduledActionStatus)
  const page = await ctx.api.scheduledActions(status, 1, 200)
  show(ctx, page, {
    kind: 'table',
    title: ct('m.info.at.title', { status: status ? ` (${actionStatus(status)})` : '', tz: page.default_timezone }),
    columns: actionColumns(),
    rows: page.items.map((a) => actionRow(ctx, a, page.default_timezone)),
  })
  if (page.items.length === 0) note(ctx, ct(status === 'pending' ? 'm.info.at.none.pending' : 'm.info.at.none.any'))
}

async function findAction(ctx: Ctx, text: string) {
  const page = await allActions(ctx)
  return { action: pick(page.items, text, 'scheduledAction', (a) => a.id), timeZone: page.default_timezone }
}

async function atShow(ctx: Ctx, inv: Invocation) {
  const { action, timeZone } = await findAction(ctx, inv.args[0])
  const detail = await ctx.api.scheduledAction(action.id)
  show(ctx, detail, { kind: 'table', columns: actionColumns(), rows: [actionRow(ctx, detail, timeZone)] })
  if (!ctx.json && detail.operation_id) await watch(ctx, detail.operation_id, detail.kind, true)
}

async function atCancel(ctx: Ctx, inv: Invocation) {
  let targets: ScheduledAction[]
  if (flag(inv, 'all')) {
    if (inv.args.length) throw new CommandError(ct('m.info.at.idsOrAll'))
    targets = (await ctx.api.scheduledActions('pending', 1, 200)).items
    if (targets.length === 0) {
      note(ctx, ct('m.info.at.nonePending'))
      return
    }
    if (!(await confirmOrCancel(ctx, inv, ct('m.info.at.confirmCancel', { count: targets.length })))) return false
  } else {
    if (inv.args.length === 0) throw new CommandError(ct('m.info.at.needId'))
    const page = await allActions(ctx)
    targets = inv.args.map((text) => pick(page.items, text, 'scheduledAction', (a) => a.id))
  }
  let ok = true
  for (const a of targets) {
    try {
      await ctx.api.cancelScheduledAction(a.id)
      note(ctx, ct('m.info.at.cancelled', { id: short(a.id), kind: KIND_LABEL[a.kind], label: a.label }), 'success')
    } catch (err) {
      ok = false
      ctx.print({ kind: 'error', message: ct('m.info.at.failed', { id: short(a.id), reason: errorMessage(err) }) })
    }
  }
  ctx.invalidate()
  return ok
}

// ---------- definições ----------

export const infoCommands: CommandDef[] = defineCommands([
  {
    name: 'status',
    aliases: ['ls', 'estado'],
    group: 'Consulta',
    usage: '[seletor...] [opções]',
    args: [{ name: 'seletor', variadic: true, complete: 'selector' }],
    options: [
      { name: 'env', value: 'ambiente', complete: 'environment' },
      { name: 'state', value: 'estado', complete: 'state' },
    ],
    examples: ['status', 'status loja', 'ls --state stopped', 'status */worker --env staging'],
    run: status,
  },
  {
    name: 'refresh',
    aliases: ['atualizar'],
    group: 'Consulta',
    examples: ['refresh'],
    run: refresh,
  },
  {
    name: 'ops',
    aliases: ['operacoes'],
    group: 'Operações',
    options: [{ name: 'limit', value: 'n' }],
    examples: ['ops', 'ops --limit 3'],
    run: ops,
  },
  {
    name: 'op',
    aliases: ['operacao'],
    group: 'Operações',
    usage: '<id> [opções]',
    args: [{ name: 'id', required: true, complete: 'operation' }],
    options: [{ name: 'no-wait' }],
    examples: ['op 3f2a91c0', 'op 3f2a91c0 --no-wait'],
    run: op,
  },
  {
    name: 'history',
    aliases: ['historico'],
    group: 'Operações',
    options: [
      { name: 'project', value: 'projeto', complete: 'project' },
      { name: 'service', value: 'serviço', complete: 'service' },
      { name: 'env', value: 'ambiente', complete: 'environment' },
      { name: 'kind', value: 'tipo', complete: { values: KINDS } },
      { name: 'result', value: 'resultado', complete: { values: RESULTS } },
      { name: 'trigger', value: 'origem', complete: { values: TRIGGERS } },
      { name: 'from', value: 'data' },
      { name: 'to', value: 'data' },
      { name: 'page', value: 'n' },
      { name: 'limit', value: 'n' },
    ],
    examples: ['history', 'history --project loja --kind stop --result failed', 'history --trigger scheduled_action --from 2026-11-01'],
    run: history,
  },
  {
    name: 'at',
    aliases: ['agendadas'],
    group: 'Agendamento',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Agendamento',
        options: [
          { name: 'all' },
          { name: 'status', value: 'situação', complete: { values: ACTION_STATUSES } },
        ],
        examples: ['at list', 'at list --all', 'at list --status failed'],
        run: atList,
      },
      {
        name: 'show',
        group: 'Agendamento',
        usage: '<id>',
        args: [{ name: 'id', required: true, complete: 'action' }],
        examples: ['at show 7c1e'],
        run: atShow,
      },
      {
        name: 'cancel',
        aliases: ['cancelar'],
        group: 'Agendamento',
        usage: '<id...> | --all',
        args: [{ name: 'id', variadic: true, complete: 'action' }],
        options: [{ name: 'all' }, YES],
        examples: ['at cancel 7c1e', 'at cancel --all -y'],
        run: atCancel,
      },
    ],
  },
])
