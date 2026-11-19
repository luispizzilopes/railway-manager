// Agendas recorrentes: list, show, create, edit, pause, resume, rm, runs.

import { ApiError } from '@/shared/api/client'
import type { Dashboard, ScheduleInput, ScheduleTarget, ScheduleView } from '@/shared/api/types'
import { KIND_LABEL, RUN_LABEL, formatDays, formatInZone } from '@/shared/lib/format'
import { flag, int, list, str } from '@/features/console/engine/parse'
import { findProject, parseSelector } from '@/features/console/state/selectors'
import { validTimeZone } from '@/features/console/lib/time'
import type { CommandDef, Ctx, Invocation } from '@/features/console/state/types'
import { CommandError } from '@/features/console/state/types'
import { YES, confirmOrCancel, note, pick, show, when } from './shared'

const DAY_NAMES: Record<string, number> = {
  seg: 0, mon: 0, ter: 1, tue: 1, qua: 2, wed: 2, qui: 3, thu: 3, sex: 4, fri: 4, sab: 5, 'sáb': 5, sat: 5, dom: 6, sun: 6,
}

/** `seg-sex`, `seg,qua,sex`, `todos`, `fds`, `sex-seg` (atravessa o domingo). */
export function parseDays(text: string): number[] {
  const lower = text.trim().toLowerCase()
  if (['todos', 'all', 'diario', 'diário'].includes(lower)) return [0, 1, 2, 3, 4, 5, 6]
  if (['fds', 'fim-de-semana', 'weekend'].includes(lower)) return [5, 6]
  if (['uteis', 'úteis', 'weekdays'].includes(lower)) return [0, 1, 2, 3, 4]
  const days = new Set<number>()
  for (const part of lower.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-')
    const from = DAY_NAMES[a.slice(0, 3)]
    const to = b === undefined ? from : DAY_NAMES[b.slice(0, 3)]
    if (from === undefined || to === undefined) {
      throw new CommandError(`dia inválido: '${part}' — use seg, ter, qua, qui, sex, sab, dom (ex.: seg-sex, seg,qua,sex, todos, fds)`)
    }
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === to) break
    }
  }
  if (days.size === 0) throw new CommandError('informe ao menos um dia')
  return [...days].sort((x, y) => x - y)
}

/** `07:00-12:00` → janela. */
export function parseWindow(text: string): { start: string; end: string } {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) throw new CommandError(`janela inválida: '${text}' — use HH:MM-HH:MM (ex.: 07:00-12:00)`)
  const pad = (h: string, mm: string) => `${h.padStart(2, '0')}:${mm}`
  return { start: pad(m[1], m[2]), end: pad(m[3], m[4]) }
}

function projectName(dashboard: Dashboard, id: string): string {
  const p = dashboard.projects.find((x) => x.project.id === id)?.project
  return p ? (p.display_name ?? p.name) : id
}

function targetText(dashboard: Dashboard, view: ScheduleView): string {
  const t = view.schedule.target
  const entry = dashboard.projects.find((x) => x.project.id === view.schedule.project_id)
  if (t.type === 'instances') {
    const names = entry?.environments.flatMap((e) =>
      e.instances.filter((i) => t.instance_ids.includes(i.id)).map((i) => `${i.service_name}@${e.environment.name}`),
    )
    return names?.length ? names.join(', ') : `${t.instance_ids.length} instância(s)`
  }
  const env = entry?.environments.find((e) => e.environment.id === t.environment_id)?.environment.name
  return t.environment_id ? `projeto inteiro · ${env ?? t.environment_id}` : 'projeto inteiro'
}

async function load(ctx: Ctx) {
  return ctx.api.schedules()
}

async function findSchedule(ctx: Ctx, text: string) {
  const { schedules } = await load(ctx)
  return pick(schedules, text, 'agenda', (s) => s.schedule.id, (s) => s.schedule.name)
}

function printWarnings(ctx: Ctx, view: ScheduleView) {
  for (const w of view.warnings) note(ctx, `⚠ ${w}`, 'warn')
}

function printNext(ctx: Ctx, view: ScheduleView) {
  if (view.next_runs.length === 0) {
    note(ctx, view.schedule.enabled ? 'sem próximas execuções' : `pausada${view.schedule.paused_reason ? `: ${view.schedule.paused_reason}` : ''}`)
    return
  }
  ctx.print({
    kind: 'table',
    title: `Próximas execuções (${view.schedule.timezone})`,
    columns: ['Quando', 'Ação'],
    rows: view.next_runs.map((r) => [formatInZone(r.at, view.schedule.timezone), KIND_LABEL[r.action]]),
  })
}

async function scheduleList(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard()
  const projectId = inv.args[0] ? findProject(dashboard, inv.args[0]).project.id : undefined
  const { schedules } = await ctx.api.schedules(projectId)
  show(ctx, schedules, {
    kind: 'table',
    columns: ['ID', 'Agenda', 'Projeto', 'Alvo', 'Dias', 'Janelas', 'Próxima', 'Situação'],
    rows: schedules.map((v) => [
      { id: v.schedule.id },
      v.schedule.name,
      projectName(dashboard, v.schedule.project_id),
      targetText(dashboard, v),
      formatDays(v.schedule.days),
      v.schedule.windows.map((w) => `${w.start}–${w.end}`).join(', '),
      v.next_runs[0] ? `${KIND_LABEL[v.next_runs[0].action]} ${formatInZone(v.next_runs[0].at, v.schedule.timezone)}` : '—',
      v.schedule.enabled
        ? { text: 'ativa', tone: 'success' }
        : { text: `pausada${v.schedule.paused_reason ? ` (${v.schedule.paused_reason})` : ''}`, tone: 'muted' },
    ]),
  })
  if (schedules.length === 0) note(ctx, 'nenhuma agenda — crie com: schedule create <projeto> --name … --days seg-sex --window 07:00-19:00')
}

async function scheduleShow(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard()
  const view = await ctx.api.schedule((await findSchedule(ctx, inv.args[0])).schedule.id)
  const runs = await ctx.api.scheduleRuns(view.schedule.id)
  if (ctx.json) {
    ctx.print({ kind: 'json', value: { ...view, runs } })
    return
  }
  const s = view.schedule
  ctx.print({
    kind: 'table',
    title: s.name,
    columns: ['Campo', 'Valor'],
    rows: [
      ['Projeto', projectName(dashboard, s.project_id)],
      ['Alvo', targetText(dashboard, view)],
      ['Dias', formatDays(s.days)],
      ['Janelas', s.windows.map((w) => `${w.start}–${w.end}`).join(', ')],
      ['Fuso', s.timezone],
      ['Situação', s.enabled ? 'ativa' : `pausada${s.paused_reason ? ` (${s.paused_reason})` : ''}`],
      ['ID', { id: s.id }],
    ],
  })
  printWarnings(ctx, view)
  printNext(ctx, view)
  printRuns(ctx, runs.items.slice(0, 5), 'Últimas execuções')
}

function printRuns(ctx: Ctx, runs: Awaited<ReturnType<Ctx['api']['scheduleRuns']>>['items'], title: string) {
  if (runs.length === 0) {
    note(ctx, 'nenhuma execução ainda')
    return
  }
  ctx.print({
    kind: 'table',
    title,
    columns: ['Previsto', 'Ação', 'Situação', 'Operação', 'Mensagem'],
    rows: runs.map((r) => [
      when(r.scheduled_for),
      KIND_LABEL[r.action],
      { text: RUN_LABEL[r.status], tone: r.status === 'failed' || r.status === 'missed' ? 'error' : 'muted' },
      r.operation_id ? { id: r.operation_id } : '',
      r.message ?? '',
    ]),
  })
}

/** Instâncias por `serviço@ambiente` (ou `serviço`, ou ID) dentro do projeto. */
function instanceIds(dashboard: Dashboard, projectId: string, specs: string[]): string[] {
  const entry = dashboard.projects.find((p) => p.project.id === projectId)!
  const all = entry.environments.flatMap((e) => e.instances.map((i) => ({ i, env: e.environment.name })))
  const ids = new Set<string>()
  for (const spec of specs) {
    const at = spec.lastIndexOf('@')
    const service = (at === -1 ? spec : spec.slice(0, at)).toLowerCase()
    const env = at === -1 ? undefined : spec.slice(at + 1).toLowerCase()
    const found = all.filter(
      ({ i, env: e }) => (i.id === spec || i.service_name.toLowerCase() === service) && (!env || e.toLowerCase() === env || i.id === spec),
    )
    if (found.length === 0) {
      throw new CommandError(`nenhuma instância '${spec}' em ${entry.project.name} — existentes: ${all.map(({ i, env: e }) => `${i.service_name}@${e}`).join(', ')}`)
    }
    for (const { i } of found) ids.add(i.id)
  }
  return [...ids]
}

function environmentId(dashboard: Dashboard, projectId: string, name: string): string {
  const entry = dashboard.projects.find((p) => p.project.id === projectId)!
  const env = entry.environments.find((e) => e.environment.name.toLowerCase() === name.toLowerCase() || e.environment.id === name)
  if (!env) {
    throw new CommandError(`nenhum ambiente '${name}' em ${entry.project.name} — existentes: ${entry.environments.map((e) => e.environment.name).join(', ')}`)
  }
  return env.environment.id
}

function checkTz(tz: string | undefined) {
  if (tz !== undefined && !validTimeZone(tz)) throw new CommandError(`fuso inválido: '${tz}' (use um nome IANA, ex.: America/Sao_Paulo)`)
}

/** Mostra o erro de agenda com as janelas em conflito, quando houver. */
async function saving(ctx: Ctx, action: () => Promise<ScheduleView>, verb: string) {
  let view: ScheduleView
  try {
    view = await action()
  } catch (err) {
    if (err instanceof ApiError && Array.isArray(err.details?.conflicts)) {
      const conflicts = (err.details.conflicts as { start: string; end: string }[]).map((w) => `${w.start}–${w.end}`)
      throw new CommandError(`${err.message} — janelas em conflito: ${conflicts.join(' × ')}`, err.details)
    }
    throw err
  }
  ctx.invalidate()
  show(ctx, view, { kind: 'text', tone: 'success', text: `agenda "${view.schedule.name}" ${verb} (${view.schedule.id})` })
  if (!ctx.json) {
    printWarnings(ctx, view)
    printNext(ctx, view)
  }
}

async function scheduleCreate(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  const sel = parseSelector(inv.args[0])
  if (sel.all || sel.service) throw new CommandError('use projeto ou projeto@ambiente como alvo (para serviços, use --instances)')
  const { project } = findProject(dashboard, sel.project!)
  const name = str(inv, 'name')
  if (!name) throw new CommandError('informe --name')
  const daysText = str(inv, 'days')
  if (!daysText) throw new CommandError('informe --days (ex.: seg-sex)')
  const windows = list(inv, 'window').map(parseWindow)
  if (windows.length === 0) throw new CommandError('informe ao menos uma --window (ex.: 07:00-19:00)')
  const tz = str(inv, 'tz')
  checkTz(tz)
  const instances = list(inv, 'instances')
  if (instances.length && sel.environment) throw new CommandError('use projeto@ambiente ou --instances, não os dois')
  const target: ScheduleTarget = instances.length
    ? { type: 'instances', instance_ids: instanceIds(dashboard, project.id, instances) }
    : { type: 'project', environment_id: sel.environment ? environmentId(dashboard, project.id, sel.environment) : null }
  const timezone = tz ?? (await load(ctx)).default_timezone
  const input: ScheduleInput = { project_id: project.id, name, timezone, days: parseDays(daysText), windows, target }
  await saving(ctx, () => ctx.api.createSchedule(input), 'criada')
}

async function scheduleEdit(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  const current = (await findSchedule(ctx, inv.args[0])).schedule
  const tz = str(inv, 'tz')
  checkTz(tz)
  const windows = list(inv, 'window').map(parseWindow)
  const instances = list(inv, 'instances')
  const env = str(inv, 'env')
  const modes = [instances.length > 0, env !== undefined, flag(inv, 'whole')].filter(Boolean).length
  if (modes > 1) throw new CommandError('use só um de --instances, --env ou --whole')
  let target = current.target
  if (instances.length) target = { type: 'instances', instance_ids: instanceIds(dashboard, current.project_id, instances) }
  if (env !== undefined) target = { type: 'project', environment_id: environmentId(dashboard, current.project_id, env) }
  if (flag(inv, 'whole')) target = { type: 'project', environment_id: null }
  const daysText = str(inv, 'days')
  const input: ScheduleInput = {
    name: str(inv, 'name') ?? current.name,
    timezone: tz ?? current.timezone,
    days: daysText ? parseDays(daysText) : current.days,
    windows: windows.length ? windows : current.windows,
    target,
  }
  await saving(ctx, () => ctx.api.updateSchedule(current.id, input), 'atualizada')
}

async function schedulePause(ctx: Ctx, inv: Invocation, pause: boolean) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  const view = pause ? await ctx.api.pauseSchedule(schedule.id) : await ctx.api.resumeSchedule(schedule.id)
  ctx.invalidate()
  show(ctx, view, { kind: 'text', tone: 'success', text: `agenda "${view.schedule.name}" ${pause ? 'pausada' : 'retomada'}` })
  if (!pause && !ctx.json) printNext(ctx, view)
}

async function scheduleRm(ctx: Ctx, inv: Invocation) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  if (!(await confirmOrCancel(ctx, inv, `Excluir a agenda "${schedule.name}"? As operações já criadas por ela ficam no histórico.`))) {
    return false
  }
  await ctx.api.deleteSchedule(schedule.id)
  ctx.invalidate()
  note(ctx, `agenda "${schedule.name}" excluída`, 'success')
}

async function scheduleRuns(ctx: Ctx, inv: Invocation) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  const page = await ctx.api.scheduleRuns(schedule.id, int(inv, 'page', 1))
  if (ctx.json) {
    ctx.print({ kind: 'json', value: page })
    return
  }
  printRuns(ctx, page.items, `Execuções de "${schedule.name}" — página ${page.page} (${page.total} no total)`)
}

// ---------- definições ----------

const SCHEDULE_ARG = { name: 'agenda', required: true, help: 'nome ou ID (prefixo)', complete: 'schedule' as const }
const FIELDS = [
  { name: 'name', value: 'nome', help: 'nome da agenda' },
  { name: 'days', value: 'dias', help: 'seg-sex, seg,qua,sex, todos, fds, uteis' },
  { name: 'window', value: 'HH:MM-HH:MM', repeatable: true, help: 'janela ligada (início liga, fim desliga); fim < início atravessa a meia-noite' },
  { name: 'tz', value: 'fuso', help: 'fuso IANA', default: 'fuso padrão das agendas' },
  { name: 'instances', value: 'lista', help: 'serviço@ambiente separados por vírgula (em vez do projeto inteiro)' },
]

export const scheduleCommands: CommandDef[] = [
  {
    name: 'schedule',
    aliases: ['agenda', 'schedules'],
    group: 'Agendamento',
    summary: 'agendas recorrentes de ligar/desligar',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Agendamento',
        summary: 'lista agendas com a próxima execução',
        usage: '[projeto]',
        args: [{ name: 'projeto', help: 'só deste projeto', complete: 'project' }],
        examples: ['schedule list', 'schedule list loja'],
        run: scheduleList,
      },
      {
        name: 'show',
        group: 'Agendamento',
        summary: 'detalhes, próximas 5 e últimas execuções',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule show comercial'],
        run: scheduleShow,
      },
      {
        name: 'create',
        aliases: ['criar'],
        group: 'Agendamento',
        summary: 'cria uma agenda para um projeto (ou ambiente, ou instâncias)',
        usage: '<projeto[@ambiente]> --name <nome> --days <dias> --window <HH:MM-HH:MM>... [opções]',
        args: [{ name: 'projeto[@ambiente]', required: true, help: 'alvo da agenda', complete: 'project' }],
        options: FIELDS,
        examples: [
          'schedule create loja --name Comercial --days seg-sex --window 07:00-12:00 --window 13:00-18:00',
          'schedule create loja@staging --name Noite --days todos --window 22:00-02:00 --tz America/Sao_Paulo',
          'schedule create loja --name Workers --days uteis --window 08:00-18:00 --instances worker@production,worker@staging',
        ],
        run: scheduleCreate,
      },
      {
        name: 'edit',
        aliases: ['editar'],
        group: 'Agendamento',
        summary: 'altera uma agenda (só os campos informados; --window substitui todas)',
        usage: '<agenda> [opções]',
        args: [SCHEDULE_ARG],
        options: [
          ...FIELDS,
          { name: 'env', value: 'ambiente', help: 'alvo: projeto inteiro restrito a um ambiente', complete: 'environment' },
          { name: 'whole', help: 'alvo: projeto inteiro, todos os ambientes' },
        ],
        examples: ['schedule edit comercial --window 08:00-18:00', 'schedule edit comercial --days seg-sab --whole'],
        run: scheduleEdit,
      },
      {
        name: 'pause',
        aliases: ['pausar'],
        group: 'Agendamento',
        summary: 'pausa (eventos durante a pausa não são recuperados)',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule pause comercial'],
        run: (ctx, inv) => schedulePause(ctx, inv, true),
      },
      {
        name: 'resume',
        aliases: ['retomar'],
        group: 'Agendamento',
        summary: 'retoma a partir do próximo evento',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule resume comercial'],
        run: (ctx, inv) => schedulePause(ctx, inv, false),
      },
      {
        name: 'rm',
        aliases: ['excluir', 'remover'],
        group: 'Agendamento',
        summary: 'exclui a agenda',
        usage: '<agenda> [-y]',
        args: [SCHEDULE_ARG],
        options: [YES],
        examples: ['schedule rm comercial'],
        run: scheduleRm,
      },
      {
        name: 'runs',
        aliases: ['execucoes'],
        group: 'Agendamento',
        summary: 'execuções da agenda, mais recentes primeiro',
        usage: '<agenda> [--page <n>]',
        args: [SCHEDULE_ARG],
        options: [{ name: 'page', value: 'n', default: '1', help: 'página (20 por página)' }],
        examples: ['schedule runs comercial'],
        run: scheduleRuns,
      },
    ],
  },
]

