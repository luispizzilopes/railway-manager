// Agendas recorrentes: list, show, create, edit, pause, resume, rm, runs.

import { ApiError } from '@/shared/api/client'
import { errorMessage } from '@/shared/i18n/errors'
import type { Dashboard, ScheduleInput, ScheduleTarget, ScheduleView } from '@/shared/api/types'
import { KIND_LABEL, RUN_LABEL, formatDays, formatInZone } from '@/shared/lib/format'
import { flag, int, list, str } from '@/features/console/engine/parse'
import { findProject, parseSelector } from '@/features/console/state/selectors'
import { validTimeZone } from '@/features/console/lib/time'
import type { CommandDef, Ctx, Invocation } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
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
      throw new CommandError(ct('m.sched.dayInvalid', { part }))
    }
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === to) break
    }
  }
  if (days.size === 0) throw new CommandError(ct('m.sched.needDay'))
  return [...days].sort((x, y) => x - y)
}

/** `07:00-12:00` → janela. */
export function parseWindow(text: string): { start: string; end: string } {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) throw new CommandError(ct('m.sched.windowInvalid', { text }))
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
    return names?.length ? names.join(', ') : ct('m.sched.instancesCount', { count: t.instance_ids.length })
  }
  const env = entry?.environments.find((e) => e.environment.id === t.environment_id)?.environment.name
  return t.environment_id ? ct('m.sched.wholeProjectEnv', { env: env ?? t.environment_id }) : ct('m.sched.wholeProject')
}

async function load(ctx: Ctx) {
  return ctx.api.schedules()
}

async function findSchedule(ctx: Ctx, text: string) {
  const { schedules } = await load(ctx)
  return pick(schedules, text, 'schedule', (s) => s.schedule.id, (s) => s.schedule.name)
}

function printWarnings(ctx: Ctx, view: ScheduleView) {
  for (const w of view.warnings) note(ctx, `⚠ ${w}`, 'warn')
}

function printNext(ctx: Ctx, view: ScheduleView) {
  if (view.next_runs.length === 0) {
    note(
      ctx,
      view.schedule.enabled
        ? ct('m.sched.noNext')
        : ct('m.sched.pausedShort', { reason: view.schedule.paused_reason ? `: ${view.schedule.paused_reason}` : '' }),
    )
    return
  }
  ctx.print({
    kind: 'table',
    title: ct('m.sched.nextTitle', { tz: view.schedule.timezone }),
    columns: [ct('m.sched.nextCols.when'), ct('m.sched.nextCols.action')],
    rows: view.next_runs.map((r) => [formatInZone(r.at, view.schedule.timezone), KIND_LABEL[r.action]]),
  })
}

async function scheduleList(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard()
  const projectId = inv.args[0] ? findProject(dashboard, inv.args[0]).project.id : undefined
  const { schedules } = await ctx.api.schedules(projectId)
  show(ctx, schedules, {
    kind: 'table',
    columns: [
      ct('m.sched.listCols.id'),
      ct('m.sched.listCols.schedule'),
      ct('m.sched.listCols.project'),
      ct('m.sched.listCols.target'),
      ct('m.sched.listCols.days'),
      ct('m.sched.listCols.windows'),
      ct('m.sched.listCols.next'),
      ct('m.sched.listCols.status'),
    ],
    rows: schedules.map((v) => [
      { id: v.schedule.id },
      v.schedule.name,
      projectName(dashboard, v.schedule.project_id),
      targetText(dashboard, v),
      formatDays(v.schedule.days),
      v.schedule.windows.map((w) => `${w.start}–${w.end}`).join(', '),
      v.next_runs[0] ? `${KIND_LABEL[v.next_runs[0].action]} ${formatInZone(v.next_runs[0].at, v.schedule.timezone)}` : '—',
      v.schedule.enabled
        ? { text: ct('m.sched.active'), tone: 'success' }
        : { text: ct('m.sched.pausedWith', { reason: v.schedule.paused_reason ? ` (${v.schedule.paused_reason})` : '' }), tone: 'muted' },
    ]),
  })
  if (schedules.length === 0) note(ctx, ct('m.sched.none'))
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
    columns: [ct('m.sched.showRows.field'), ct('m.sched.showRows.value')],
    rows: [
      [ct('m.sched.showRows.project'), projectName(dashboard, s.project_id)],
      [ct('m.sched.showRows.target'), targetText(dashboard, view)],
      [ct('m.sched.showRows.days'), formatDays(s.days)],
      [ct('m.sched.showRows.windows'), s.windows.map((w) => `${w.start}–${w.end}`).join(', ')],
      [ct('m.sched.showRows.tz'), s.timezone],
      [
        ct('m.sched.showRows.status'),
        s.enabled ? ct('m.sched.active') : ct('m.sched.pausedWith', { reason: s.paused_reason ? ` (${s.paused_reason})` : '' }),
      ],
      [ct('m.sched.showRows.id'), { id: s.id }],
    ],
  })
  printWarnings(ctx, view)
  printNext(ctx, view)
  printRuns(ctx, runs.items.slice(0, 5), ct('m.sched.lastRuns'))
}

function printRuns(ctx: Ctx, runs: Awaited<ReturnType<Ctx['api']['scheduleRuns']>>['items'], title: string) {
  if (runs.length === 0) {
    note(ctx, ct('m.sched.noRuns'))
    return
  }
  ctx.print({
    kind: 'table',
    title,
    columns: [ct('m.sched.runCols.scheduled'), ct('m.sched.runCols.action'), ct('m.sched.runCols.status'), ct('m.sched.runCols.operation'), ct('m.sched.runCols.message')],
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
      throw new CommandError(
        ct('m.sched.noInstance', { spec, project: entry.project.name, list: all.map(({ i, env: e }) => `${i.service_name}@${e}`).join(', ') }),
      )
    }
    for (const { i } of found) ids.add(i.id)
  }
  return [...ids]
}

function environmentId(dashboard: Dashboard, projectId: string, name: string): string {
  const entry = dashboard.projects.find((p) => p.project.id === projectId)!
  const env = entry.environments.find((e) => e.environment.name.toLowerCase() === name.toLowerCase() || e.environment.id === name)
  if (!env) {
    throw new CommandError(
      ct('m.sched.noEnvironment', { name, project: entry.project.name, list: entry.environments.map((e) => e.environment.name).join(', ') }),
    )
  }
  return env.environment.id
}

function checkTz(tz: string | undefined) {
  if (tz !== undefined && !validTimeZone(tz)) throw new CommandError(ct('m.sched.zoneInvalid', { tz }))
}

/** Mostra o erro de agenda com as janelas em conflito, quando houver. */
async function saving(ctx: Ctx, action: () => Promise<ScheduleView>, verb: 'created' | 'updated') {
  let view: ScheduleView
  try {
    view = await action()
  } catch (err) {
    if (err instanceof ApiError && Array.isArray(err.details?.conflicts)) {
      const conflicts = (err.details.conflicts as { start: string; end: string }[]).map((w) => `${w.start}–${w.end}`)
      throw new CommandError(ct('m.sched.conflict', { message: errorMessage(err), list: conflicts.join(' × ') }), err.details)
    }
    throw err
  }
  ctx.invalidate()
  show(ctx, view, { kind: 'text', tone: 'success', text: ct('m.sched.saved', { name: view.schedule.name, verb: ct(`m.sched.${verb}`), id: view.schedule.id }) })
  if (!ctx.json) {
    printWarnings(ctx, view)
    printNext(ctx, view)
  }
}

async function scheduleCreate(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  const sel = parseSelector(inv.args[0])
  if (sel.all || sel.service) throw new CommandError(ct('m.sched.targetNeeded'))
  const { project } = findProject(dashboard, sel.project!)
  const name = str(inv, 'name')
  if (!name) throw new CommandError(ct('m.sched.needName'))
  const daysText = str(inv, 'days')
  if (!daysText) throw new CommandError(ct('m.sched.needDays'))
  const windows = list(inv, 'window').map(parseWindow)
  if (windows.length === 0) throw new CommandError(ct('m.sched.needWindow'))
  const tz = str(inv, 'tz')
  checkTz(tz)
  const instances = list(inv, 'instances')
  if (instances.length && sel.environment) throw new CommandError(ct('m.sched.envOrInstances'))
  const target: ScheduleTarget = instances.length
    ? { type: 'instances', instance_ids: instanceIds(dashboard, project.id, instances) }
    : { type: 'project', environment_id: sel.environment ? environmentId(dashboard, project.id, sel.environment) : null }
  const timezone = tz ?? (await load(ctx)).default_timezone
  const input: ScheduleInput = { project_id: project.id, name, timezone, days: parseDays(daysText), windows, target }
  await saving(ctx, () => ctx.api.createSchedule(input), 'created')
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
  if (modes > 1) throw new CommandError(ct('m.sched.oneMode'))
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
  await saving(ctx, () => ctx.api.updateSchedule(current.id, input), 'updated')
}

async function schedulePause(ctx: Ctx, inv: Invocation, pause: boolean) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  const view = pause ? await ctx.api.pauseSchedule(schedule.id) : await ctx.api.resumeSchedule(schedule.id)
  ctx.invalidate()
  show(ctx, view, { kind: 'text', tone: 'success', text: ct(pause ? 'm.sched.pausedDone' : 'm.sched.resumedDone', { name: view.schedule.name }) })
  if (!pause && !ctx.json) printNext(ctx, view)
}

async function scheduleRm(ctx: Ctx, inv: Invocation) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  if (!(await confirmOrCancel(ctx, inv, ct('m.sched.confirmDelete', { name: schedule.name })))) {
    return false
  }
  await ctx.api.deleteSchedule(schedule.id)
  ctx.invalidate()
  note(ctx, ct('m.sched.deleted', { name: schedule.name }), 'success')
}

async function scheduleRuns(ctx: Ctx, inv: Invocation) {
  const { schedule } = await findSchedule(ctx, inv.args[0])
  const page = await ctx.api.scheduleRuns(schedule.id, int(inv, 'page', 1))
  if (ctx.json) {
    ctx.print({ kind: 'json', value: page })
    return
  }
  printRuns(ctx, page.items, ct('m.sched.runsTitle', { name: schedule.name, page: page.page, total: page.total }))
}

// ---------- definições ----------

const SCHEDULE_ARG = { name: 'agenda', required: true, complete: 'schedule' as const }
const FIELDS = [
  { name: 'name', value: 'nome' },
  { name: 'days', value: 'dias' },
  { name: 'window', value: 'HH:MM-HH:MM', repeatable: true },
  { name: 'tz', value: 'fuso' },
  { name: 'instances', value: 'lista' },
]

export const scheduleCommands: CommandDef[] = defineCommands([
  {
    name: 'schedule',
    aliases: ['agenda', 'schedules'],
    group: 'Agendamento',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Agendamento',
        usage: '[projeto]',
        args: [{ name: 'projeto', complete: 'project' }],
        examples: ['schedule list', 'schedule list loja'],
        run: scheduleList,
      },
      {
        name: 'show',
        group: 'Agendamento',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule show comercial'],
        run: scheduleShow,
      },
      {
        name: 'create',
        aliases: ['criar'],
        group: 'Agendamento',
        usage: '<projeto[@ambiente]> --name <nome> --days <dias> --window <HH:MM-HH:MM>... [opções]',
        args: [{ name: 'projeto[@ambiente]', required: true, complete: 'project' }],
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
        usage: '<agenda> [opções]',
        args: [SCHEDULE_ARG],
        options: [
          ...FIELDS,
          { name: 'env', value: 'ambiente', complete: 'environment' },
          { name: 'whole' },
        ],
        examples: ['schedule edit comercial --window 08:00-18:00', 'schedule edit comercial --days seg-sab --whole'],
        run: scheduleEdit,
      },
      {
        name: 'pause',
        aliases: ['pausar'],
        group: 'Agendamento',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule pause comercial'],
        run: (ctx, inv) => schedulePause(ctx, inv, true),
      },
      {
        name: 'resume',
        aliases: ['retomar'],
        group: 'Agendamento',
        usage: '<agenda>',
        args: [SCHEDULE_ARG],
        examples: ['schedule resume comercial'],
        run: (ctx, inv) => schedulePause(ctx, inv, false),
      },
      {
        name: 'rm',
        aliases: ['excluir', 'remover'],
        group: 'Agendamento',
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
        usage: '<agenda> [--page <n>]',
        args: [SCHEDULE_ARG],
        options: [{ name: 'page', value: 'n' }],
        examples: ['schedule runs comercial'],
        run: scheduleRuns,
      },
    ],
  },
])

