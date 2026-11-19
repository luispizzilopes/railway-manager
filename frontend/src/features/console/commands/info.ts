// Consultas: status, refresh, ops, op, history e ações agendadas (at).

import type { HistoryFilters, ScheduledAction, ScheduledActionStatus } from '@/shared/api/types'
import { KIND_LABEL, RESULT_LABEL, STATUS_LABEL } from '@/shared/lib/format'
import { flag, int, str } from '../parse'
import { findProject, flatten, resolveSelectors } from '../selectors'
import { describeWhen } from '../time'
import type { Cell, CommandDef, Ctx, Invocation } from '../types'
import { CommandError } from '../types'
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
      text: `${i.projects} projeto(s) · ${i.instances} instância(s): ${i.running} ativas, ${i.sleeping} dormindo, ${i.stopped} desligadas, ${i.failed} com falha, ${i.other} outras`,
    })
    for (const a of dashboard.alerts) ctx.print({ kind: 'text', tone: 'warn', text: `⚠ ${a.message}` })
    if (!dashboard.integration_ready) note(ctx, 'integração não configurada: use credential set', 'warn')
  }
  if (instances.length === 0) {
    note(ctx, 'nenhuma instância gerenciada — importe com: project import --all; instance import <projeto> --all')
    return
  }
  ctx.print({
    kind: 'table',
    columns: ['Projeto', 'Serviço', 'Ambiente', 'Estado', 'Próxima ação', 'ID'],
    rows: instances.map((i) => {
      const n = next.get(i.projectId)
      return [
        i.projectName,
        i.service + (i.busy ? ' (em operação)' : ''),
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
    text: `estados atualizados: ${report.refreshed} lidos, ${report.not_found} não encontrados, ${report.failed} falhas`,
  })
}

// ---------- operações ----------

async function ops(ctx: Ctx, inv: Invocation) {
  const recent = (await ctx.dashboard(true)).recent_operations.slice(0, int(inv, 'limit', 10))
  show(ctx, recent, {
    kind: 'table',
    columns: ['ID', 'Tipo', 'Origem', 'Situação', 'Itens', 'Projetos', 'Criada'],
    rows: recent.map((s) => [
      { id: s.operation.id },
      KIND_LABEL[s.operation.kind],
      s.operation.trigger,
      STATUS_LABEL[s.operation.status],
      `${s.succeeded} ok · ${s.failed} falhas · ${s.skipped} ignorados${s.active ? ` · ${s.active} ativos` : ''}`,
      s.projects.join(', '),
      when(s.operation.created_at),
    ]),
  })
  if (recent.length === 0) note(ctx, 'nenhuma operação recente')
}

async function op(ctx: Ctx, inv: Invocation) {
  let id = inv.args[0]
  if (!UUID.test(id)) {
    const recent = (await ctx.dashboard(true)).recent_operations.map((s) => s.operation)
    id = pick(recent, id, 'operação', (o) => o.id).id
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
    throw new CommandError(`--${name} inválido: '${value}' — use ${allowed.join(', ')}`)
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
  if (found.size === 0) throw new CommandError(`nenhum serviço '${text}' nos projetos gerenciados`)
  if (found.size > 1) throw new CommandError(`'${text}' existe em vários projetos: informe também --project`)
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
    title: `Histórico — página ${page.page} de ${Math.max(1, Math.ceil(page.total / page.per_page))} (${page.total} itens)`,
    columns: ['Quando', 'Tipo', 'Projeto', 'Serviço', 'Ambiente', 'Resultado', 'Origem', 'Mensagem'],
    rows: page.items.map((h) => [
      when(h.created_at),
      KIND_LABEL[h.kind],
      h.item.label.project_name,
      h.item.label.service_name,
      h.item.label.environment_name,
      { result: h.item.result },
      h.trigger === 'schedule'
        ? `agenda ${h.schedule_name ?? ''}`
        : h.trigger === 'scheduled_action'
          ? `ação agendada (${h.scheduled_action_label ?? ''})`
          : h.requested_by,
      h.item.error_message ?? '',
    ]),
  })
}

// ---------- ações agendadas ----------

const ACTION_STATUS: Record<ScheduledActionStatus, string> = {
  pending: 'pendente',
  processing: 'executando',
  executed: 'executada',
  late: 'executada com atraso',
  skipped: 'ignorada',
  missed: 'perdida',
  failed: 'falhou',
  cancelled: 'cancelada',
}

function actionRow(ctx: Ctx, a: ScheduledAction, timeZone: string): Cell[] {
  const tone = a.status === 'failed' || a.status === 'missed' ? 'error' : a.status === 'pending' ? 'info' : 'muted'
  return [
    { id: a.id },
    KIND_LABEL[a.kind],
    a.status === 'pending' ? describeWhen(new Date(a.run_at), timeZone, ctx.now()) : when(a.run_at),
    a.label,
    { text: ACTION_STATUS[a.status] + (a.message ? ` — ${a.message}` : ''), tone },
    a.operation_id ? { id: a.operation_id } : '',
    a.note ?? '',
  ]
}

const ACTION_COLUMNS = ['ID', 'Ação', 'Quando', 'Alvo', 'Situação', 'Operação', 'Observação']

async function allActions(ctx: Ctx) {
  return ctx.api.scheduledActions(undefined, 1, 200)
}

async function atList(ctx: Ctx, inv: Invocation) {
  const raw = str(inv, 'status')
  const statuses = Object.keys(ACTION_STATUS)
  const status = flag(inv, 'all') ? undefined : ((oneOf('status', raw, statuses) ?? 'pending') as ScheduledActionStatus)
  const page = await ctx.api.scheduledActions(status, 1, 200)
  show(ctx, page, {
    kind: 'table',
    title: `Ações agendadas${status ? ` (${ACTION_STATUS[status]})` : ''} — fuso ${page.default_timezone}`,
    columns: ACTION_COLUMNS,
    rows: page.items.map((a) => actionRow(ctx, a, page.default_timezone)),
  })
  if (page.items.length === 0) note(ctx, status === 'pending' ? 'nenhuma ação pendente — crie com: stop <seletor> --at 18:00' : 'nenhuma ação')
}

async function findAction(ctx: Ctx, text: string) {
  const page = await allActions(ctx)
  return { action: pick(page.items, text, 'ação agendada', (a) => a.id), timeZone: page.default_timezone }
}

async function atShow(ctx: Ctx, inv: Invocation) {
  const { action, timeZone } = await findAction(ctx, inv.args[0])
  const detail = await ctx.api.scheduledAction(action.id)
  show(ctx, detail, { kind: 'table', columns: ACTION_COLUMNS, rows: [actionRow(ctx, detail, timeZone)] })
  if (!ctx.json && detail.operation_id) await watch(ctx, detail.operation_id, detail.kind, true)
}

async function atCancel(ctx: Ctx, inv: Invocation) {
  let targets: ScheduledAction[]
  if (flag(inv, 'all')) {
    if (inv.args.length) throw new CommandError('use IDs ou --all, não os dois')
    targets = (await ctx.api.scheduledActions('pending', 1, 200)).items
    if (targets.length === 0) {
      note(ctx, 'nenhuma ação pendente')
      return
    }
    if (!(await confirmOrCancel(ctx, inv, `Cancelar ${targets.length} ação(ões) pendente(s)?`))) return false
  } else {
    if (inv.args.length === 0) throw new CommandError('informe o ID da ação (veja at list) ou --all')
    const page = await allActions(ctx)
    targets = inv.args.map((text) => pick(page.items, text, 'ação agendada', (a) => a.id))
  }
  let ok = true
  for (const a of targets) {
    try {
      await ctx.api.cancelScheduledAction(a.id)
      note(ctx, `ação ${short(a.id)} cancelada (${KIND_LABEL[a.kind]} · ${a.label})`, 'success')
    } catch (err) {
      ok = false
      ctx.print({ kind: 'error', message: `ação ${short(a.id)}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  ctx.invalidate()
  return ok
}

// ---------- definições ----------

export const infoCommands: CommandDef[] = [
  {
    name: 'status',
    aliases: ['ls', 'estado'],
    group: 'Consulta',
    summary: 'visão geral: indicadores, alertas e estado de cada instância',
    usage: '[seletor...] [opções]',
    args: [{ name: 'seletor', variadic: true, help: 'filtra as instâncias (padrão: todas)', complete: 'selector' }],
    options: [
      { name: 'env', value: 'ambiente', help: 'só um ambiente', complete: 'environment' },
      { name: 'state', value: 'estado', help: 'só instâncias neste estado', complete: 'state' },
    ],
    examples: ['status', 'status loja', 'ls --state stopped', 'status */worker --env staging'],
    run: status,
  },
  {
    name: 'refresh',
    aliases: ['atualizar'],
    group: 'Consulta',
    summary: 'lê de novo o estado de todas as instâncias no Railway',
    examples: ['refresh'],
    run: refresh,
  },
  {
    name: 'ops',
    aliases: ['operacoes'],
    group: 'Operações',
    summary: 'operações recentes',
    options: [{ name: 'limit', value: 'n', default: '10', help: 'quantas mostrar' }],
    examples: ['ops', 'ops --limit 3'],
    run: ops,
  },
  {
    name: 'op',
    aliases: ['operacao'],
    group: 'Operações',
    summary: 'mostra e acompanha uma operação até o fim',
    usage: '<id> [opções]',
    args: [{ name: 'id', required: true, help: 'ID completo ou prefixo (de ops)', complete: 'operation' }],
    options: [{ name: 'no-wait', help: 'mostra o estado atual sem acompanhar' }],
    examples: ['op 3f2a91c0', 'op 3f2a91c0 --no-wait'],
    run: op,
  },
  {
    name: 'history',
    aliases: ['historico'],
    group: 'Operações',
    summary: 'histórico de itens de operações, com os filtros da tela',
    options: [
      { name: 'project', value: 'projeto', help: 'projeto (nome ou ID)', complete: 'project' },
      { name: 'service', value: 'serviço', help: 'serviço (nome ou ID Railway)', complete: 'service' },
      { name: 'env', value: 'ambiente', help: 'ambiente', complete: 'environment' },
      { name: 'kind', value: 'tipo', help: 'start ou stop', complete: { values: KINDS } },
      { name: 'result', value: 'resultado', help: RESULTS.join(', '), complete: { values: RESULTS } },
      { name: 'trigger', value: 'origem', help: TRIGGERS.join(', '), complete: { values: TRIGGERS } },
      { name: 'from', value: 'data', help: 'a partir de (AAAA-MM-DD ou RFC 3339)' },
      { name: 'to', value: 'data', help: 'até (AAAA-MM-DD ou RFC 3339, inclusive)' },
      { name: 'page', value: 'n', default: '1', help: 'página' },
      { name: 'limit', value: 'n', default: '20', help: 'itens por página' },
    ],
    examples: ['history', 'history --project loja --kind stop --result failed', 'history --trigger scheduled_action --from 2026-11-01'],
    run: history,
  },
  {
    name: 'at',
    aliases: ['agendadas'],
    group: 'Agendamento',
    summary: 'ações agendadas pontuais (criadas com start/stop --at/--in)',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Agendamento',
        summary: 'lista ações agendadas (padrão: pendentes)',
        options: [
          { name: 'all', help: 'inclui executadas, canceladas, perdidas…' },
          { name: 'status', value: 'situação', help: Object.keys(ACTION_STATUS).join(', '), complete: { values: Object.keys(ACTION_STATUS) } },
        ],
        examples: ['at list', 'at list --all', 'at list --status failed'],
        run: atList,
      },
      {
        name: 'show',
        group: 'Agendamento',
        summary: 'mostra uma ação e a operação que ela gerou',
        usage: '<id>',
        args: [{ name: 'id', required: true, help: 'ID ou prefixo', complete: 'action' }],
        examples: ['at show 7c1e'],
        run: atShow,
      },
      {
        name: 'cancel',
        aliases: ['cancelar'],
        group: 'Agendamento',
        summary: 'cancela ações pendentes',
        usage: '<id...> | --all',
        args: [{ name: 'id', variadic: true, help: 'IDs ou prefixos', complete: 'action' }],
        options: [{ name: 'all', help: 'cancela todas as pendentes' }, YES],
        examples: ['at cancel 7c1e', 'at cancel --all -y'],
        run: atCancel,
      },
    ],
  },
]
