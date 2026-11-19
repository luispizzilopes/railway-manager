// Cadastro: projetos, instâncias, serviços e credencial.

import type { CredentialKind, DiscoveredEnvironment, ProjectImportReport, InstanceImportReport } from '@/shared/api/types'
import { SYNC_LABEL } from '@/shared/lib/format'
import { flag, str } from '@/features/console/engine/parse'
import { findProject, instanceName, parseSelector, resolveSelectors } from '@/features/console/state/selectors'
import type { CommandDef, Ctx, Invocation } from '@/features/console/state/types'
import { ct, defineCommands } from '@/features/console/lib/i18n'
import { CommandError } from '@/features/console/state/types'
import { YES, confirmOrCancel, note, show, when } from './shared'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function importReport(ctx: Ctx, report: ProjectImportReport | InstanceImportReport, what: 'project' | 'instance') {
  const imported = report.imported.length
  show(ctx, report, {
    kind: 'text',
    tone: report.failed.length ? 'warn' : 'success',
    text: [
      ct('m.manage.importReport', { imported, what: ct(`m.manage.what.${what}`), already: report.already_managed.length, failed: report.failed.length }),
      ...report.failed.map((f) => `  ✗ ${f.id}: ${f.reason}`),
    ].join('\n'),
  })
}

// ---------- projetos ----------

async function projectList(ctx: Ctx) {
  const { projects } = await ctx.api.projects()
  show(ctx, projects, {
    kind: 'table',
    columns: [
      ct('m.manage.listCols.project'),
      ct('m.manage.listCols.railwayName'),
      ct('m.manage.listCols.sync'),
      ct('m.manage.listCols.last'),
      ct('m.manage.listCols.id'),
      ct('m.manage.listCols.railwayId'),
    ],
    rows: projects.map((p) => [
      p.display_name ?? p.name,
      p.name,
      SYNC_LABEL[p.sync_status],
      when(p.last_synced_at),
      { id: p.id },
      { id: p.railway_project_id },
    ]),
  })
  if (projects.length === 0) note(ctx, ct('m.manage.noProjects'))
}

async function discovered(ctx: Ctx) {
  return (await ctx.api.discoverProjects()).workspaces.flatMap((w) =>
    w.projects.map((p) => ({ ...p, workspace: w.workspace?.name ?? ct('m.manage.personal') })),
  )
}

async function projectDiscover(ctx: Ctx) {
  const all = await discovered(ctx)
  show(ctx, all, {
    kind: 'table',
    columns: [ct('m.manage.discoverCols.workspace'), ct('m.manage.discoverCols.project'), ct('m.manage.discoverCols.managed'), ct('m.manage.discoverCols.railwayId')],
    rows: all.map((p) => [
      p.workspace,
      p.project.name,
      p.managed ? { text: ct('m.manage.yes'), tone: 'success' } : { text: ct('m.manage.no'), tone: 'muted' },
      { id: p.project.id },
    ]),
  })
}

async function projectImport(ctx: Ctx, inv: Invocation) {
  const all = await discovered(ctx)
  let ids: string[]
  if (flag(inv, 'all')) {
    if (inv.args.length) throw new CommandError(ct('m.manage.namesOrAll'))
    ids = all.filter((p) => !p.managed).map((p) => p.project.id)
    if (ids.length === 0) {
      note(ctx, ct('m.manage.allManaged'), 'info')
      return
    }
  } else {
    if (inv.args.length === 0) throw new CommandError(ct('m.manage.needProjects'))
    ids = inv.args.map((text) => {
      if (UUID.test(text)) return text
      const found = all.filter((p) => p.project.name.toLowerCase() === text.toLowerCase())
      if (found.length !== 1) {
        throw new CommandError(
          found.length ? ct('m.manage.multiWorkspace', { text }) : ct('m.manage.noRailwayProject', { text }),
        )
      }
      return found[0].project.id
    })
  }
  const report = await ctx.api.importProjects(ids)
  ctx.invalidate()
  importReport(ctx, report, 'project')
  return report.failed.length === 0
}

async function projectAdd(ctx: Ctx, inv: Invocation) {
  const { project } = await ctx.api.createProject(inv.args[0], str(inv, 'name'))
  ctx.invalidate()
  show(ctx, project, { kind: 'text', tone: 'success', text: ct('m.manage.projectAdded', { name: project.display_name ?? project.name, id: project.id }) })
}

async function projectShow(ctx: Ctx, inv: Invocation) {
  const entry = findProject(await ctx.dashboard(true), inv.args[0])
  const { project } = await ctx.api.project(entry.project.id)
  const { schedules } = await ctx.api.schedules(project.id)
  if (ctx.json) {
    ctx.print({ kind: 'json', value: { project, environments: entry.environments, schedules } })
    return
  }
  ctx.print({
    kind: 'table',
    title: project.display_name ?? project.name,
    columns: [ct('m.manage.showRows.field'), ct('m.manage.showRows.value')],
    rows: [
      [ct('m.manage.showRows.railwayName'), project.name],
      [ct('m.manage.showRows.description'), project.description ?? ''],
      [ct('m.manage.showRows.sync'), `${SYNC_LABEL[project.sync_status]} · ${when(project.last_synced_at)}`],
      [ct('m.manage.showRows.id'), { id: project.id }],
      [ct('m.manage.showRows.railwayId'), { id: project.railway_project_id }],
      [ct('m.manage.showRows.schedules'), schedules.map((s) => s.schedule.name).join(', ') || '—'],
      [ct('m.manage.showRows.nextAction'), entry.next_action ? `${entry.next_action.action} ${when(entry.next_action.at)}` : '—'],
    ],
  })
  ctx.print({
    kind: 'table',
    title: ct('m.manage.instances'),
    columns: [ct('m.manage.instCols.service'), ct('m.manage.instCols.environment'), ct('m.manage.instCols.state'), ct('m.manage.instCols.id')],
    rows: entry.environments.flatMap(({ environment, instances }) =>
      instances.map((i) => [i.service_name, environment.name, { state: i.state }, { id: i.id }]),
    ),
  })
}

async function projectEdit(ctx: Ctx, inv: Invocation) {
  const name = str(inv, 'name')
  const description = str(inv, 'description')
  if (name === undefined && description === undefined) throw new CommandError(ct('m.manage.needNameOrDesc'))
  const { project } = findProject(await ctx.dashboard(true), inv.args[0])
  const updated = await ctx.api.editProject(project.id, {
    display_name: name === undefined ? project.display_name : name || null,
    description: description === undefined ? project.description : description || null,
  })
  ctx.invalidate()
  show(ctx, updated, { kind: 'text', tone: 'success', text: ct('m.manage.projectUpdated', { name: updated.project.display_name ?? updated.project.name }) })
}

async function projectSync(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  if (!flag(inv, 'all') && inv.args.length === 0) throw new CommandError(ct('m.manage.needProjectsOrAll'))
  const projects = flag(inv, 'all') ? dashboard.projects : inv.args.map((a) => findProject(dashboard, a))
  let ok = true
  for (const { project } of projects) {
    const { report, project: synced } = await ctx.api.syncProject(project.id)
    ok &&= synced.sync_status === 'ok'
    show(ctx, report, {
      kind: 'text',
      tone: synced.sync_status === 'ok' ? 'success' : 'warn',
      text: ct('m.manage.synced', {
        name: synced.display_name ?? synced.name,
        status: SYNC_LABEL[synced.sync_status],
        refreshed: report.refreshed,
        notFound: report.not_found,
        failed: report.failed,
      }),
    })
  }
  ctx.invalidate()
  return ok
}

async function projectRm(ctx: Ctx, inv: Invocation) {
  const entry = findProject(await ctx.dashboard(true), inv.args[0])
  const { schedules } = await ctx.api.schedules(entry.project.id)
  const instances = entry.environments.reduce((n, e) => n + e.instances.length, 0)
  const name = entry.project.display_name ?? entry.project.name
  note(
    ctx,
    ct('m.manage.removeWarn', { name, instances, schedules: schedules.length }),
    'warn',
  )
  if (!(await confirmOrCancel(ctx, inv, ct('m.manage.confirmRemoveProject', { name })))) return false
  await ctx.api.removeProject(entry.project.id)
  ctx.invalidate()
  note(ctx, ct('m.manage.projectRemoved', { name }), 'success')
}

// ---------- instâncias e serviços ----------

async function instanceList(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  const instances = resolveSelectors(dashboard, inv.args.length ? inv.args : ['all'], {
    env: str(inv, 'env'),
    state: str(inv, 'state'),
  })
  show(ctx, instances, {
    kind: 'table',
    columns: [ct('m.manage.instListCols.instance'), ct('m.manage.instListCols.state'), ct('m.manage.instListCols.id')],
    rows: instances.map((i) => [instanceName(i), { state: i.state }, { id: i.id }]),
  })
}

async function discoverIn(ctx: Ctx, projectText: string) {
  const entry = findProject(await ctx.dashboard(true), projectText)
  const { environments } = await ctx.api.discoverInstances(entry.project.id)
  return { project: entry.project, environments }
}

function flatDiscovered(environments: DiscoveredEnvironment[]) {
  return environments.flatMap((e) =>
    e.instances.map((i) => ({ ...i, environment: e.environment.name, environment_id: e.environment.id, ephemeral: e.environment.is_ephemeral })),
  )
}

async function instanceDiscover(ctx: Ctx, inv: Invocation) {
  const { environments } = await discoverIn(ctx, inv.args[0])
  const rows = flatDiscovered(environments)
  show(ctx, environments, {
    kind: 'table',
    columns: [ct('m.manage.discInstCols.environment'), ct('m.manage.discInstCols.service'), ct('m.manage.discInstCols.state'), ct('m.manage.discInstCols.managed')],
    rows: rows.map((r) => [
      r.environment + (r.ephemeral ? ct('m.manage.ephemeral') : ''),
      r.service_name,
      { state: r.state },
      r.managed ? { text: ct('m.manage.yes'), tone: 'success' } : { text: ct('m.manage.no'), tone: 'muted' },
    ]),
  })
}

/** `serviço@ambiente` (nomes, curingas ou IDs Railway) entre as instâncias descobertas. */
function matchDiscovered(rows: ReturnType<typeof flatDiscovered>, text: string, project: string) {
  const { project: service, environment } = parseSelector(text)
  const re = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
  const found = rows.filter(
    (r) =>
      (re(service!).test(r.service_name) || r.service_id === service) &&
      (!environment || re(environment).test(r.environment) || r.environment_id === environment),
  )
  if (found.length === 0) throw new CommandError(ct('m.manage.noInstanceOnRailway', { text, project }))
  return found
}

async function instanceImport(ctx: Ctx, inv: Invocation) {
  const [projectText, ...specs] = inv.args
  const { project, environments } = await discoverIn(ctx, projectText)
  let rows = flatDiscovered(environments)
  const env = str(inv, 'env')
  if (env) rows = rows.filter((r) => r.environment.toLowerCase() === env.toLowerCase())
  let chosen: typeof rows
  if (flag(inv, 'all')) {
    if (specs.length) throw new CommandError(ct('m.manage.specOrAll'))
    chosen = rows.filter((r) => !r.managed && !r.ephemeral)
  } else {
    if (specs.length === 0) throw new CommandError(ct('m.manage.needSpec'))
    chosen = specs.flatMap((s) => matchDiscovered(rows, s, project.name))
  }
  if (chosen.length === 0) {
    note(ctx, ct('m.manage.nothingToImport'), 'info')
    return
  }
  const report = await ctx.api.importInstances(
    project.id,
    chosen.map((r) => ({ environment_id: r.environment_id, service_id: r.service_id })),
  )
  ctx.invalidate()
  importReport(ctx, report, 'instance')
  return report.failed.length === 0
}

async function instanceAdd(ctx: Ctx, inv: Invocation) {
  const [projectText, spec] = inv.args
  const { project, environments } = await discoverIn(ctx, projectText)
  const found = matchDiscovered(flatDiscovered(environments), spec, project.name)
  if (found.length !== 1) throw new CommandError(ct('m.manage.ambiguousInstance', { spec, count: found.length }))
  const { instance } = await ctx.api.associateInstance(project.id, {
    environment_id: found[0].environment_id,
    service_id: found[0].service_id,
  })
  ctx.invalidate()
  show(ctx, instance, {
    kind: 'text',
    tone: 'success',
    text: ct('m.manage.associated', { instance: `${instance.service.name}@${instance.environment.name}`, project: project.display_name ?? project.name }),
  })
}

async function instanceRm(ctx: Ctx, inv: Invocation) {
  const targets = resolveSelectors(await ctx.dashboard(true), inv.args, { env: str(inv, 'env') })
  note(ctx, targets.map(instanceName).join('\n'))
  if (!(await confirmOrCancel(ctx, inv, ct('m.manage.confirmRemoveInstances', { count: targets.length })))) {
    return false
  }
  for (const t of targets) await ctx.api.removeInstance(t.id)
  ctx.invalidate()
  note(ctx, ct('m.manage.instancesRemoved', { count: targets.length }), 'success')
}

async function serviceRm(ctx: Ctx, inv: Invocation) {
  const sel = parseSelector(inv.args[0])
  if (sel.all || !sel.service || sel.environment) throw new CommandError(ct('m.manage.serviceSyntax'))
  const { project } = findProject(await ctx.dashboard(true), sel.project!)
  const views = (await ctx.api.instances(project.id)).instances.filter(
    (v) => v.service.name.toLowerCase() === sel.service!.toLowerCase() || v.service.id === sel.service,
  )
  if (views.length === 0) throw new CommandError(ct('m.manage.noService', { service: sel.service, project: project.name }))
  const service = views[0].service
  note(ctx, ct('m.manage.serviceWarn', { service: service.name, count: views.length, envs: views.map((v) => v.environment.name).join(', ') }), 'warn')
  if (!(await confirmOrCancel(ctx, inv, ct('m.manage.confirmRemoveService', { project: project.name, service: service.name })))) return false
  await ctx.api.removeService(service.id)
  ctx.invalidate()
  note(ctx, ct('m.manage.serviceRemoved', { service: service.name }), 'success')
}

// ---------- credencial ----------

async function credentialShow(ctx: Ctx) {
  const { credential } = await ctx.api.credential()
  if (!credential) {
    show(ctx, null, { kind: 'text', tone: 'warn', text: ct('m.manage.noToken') })
    return
  }
  show(ctx, credential, {
    kind: 'table',
    columns: [ct('m.manage.credCols.kind'), ct('m.manage.credCols.account'), ct('m.manage.credCols.suffix'), ct('m.manage.credCols.status'), ct('m.manage.credCols.validated'), ct('m.manage.credCols.workspace')],
    rows: [
      [
        credential.kind,
        credential.label,
        `…${credential.masked_suffix}`,
        { text: credential.status, tone: credential.status === 'valid' ? 'success' : 'error' },
        when(credential.validated_at),
        credential.workspace_id ?? '—',
      ],
    ],
  })
}

async function credentialSet(ctx: Ctx, inv: Invocation) {
  const kind = inv.args[0] as CredentialKind
  if (kind !== 'account' && kind !== 'workspace') throw new CommandError(ct('m.manage.kindInvalid'))
  const workspace = str(inv, 'workspace')
  if (kind === 'workspace' && !workspace) throw new CommandError(ct('m.manage.needWorkspace'))
  const token = await ctx.secret(ct('m.manage.tokenPrompt', { kind }))
  if (!token) {
    note(ctx, ct('m.common.cancelled'))
    return false
  }
  const { credential } = await ctx.api.saveCredential({ kind, token, workspace_id: workspace })
  ctx.invalidate()
  note(ctx, ct('m.manage.tokenSaved', { label: credential.label, suffix: credential.masked_suffix }), 'success')
}

async function credentialRm(ctx: Ctx, inv: Invocation) {
  if (!(await confirmOrCancel(ctx, inv, ct('m.manage.confirmRemoveToken')))) return false
  await ctx.api.removeCredential()
  ctx.invalidate()
  note(ctx, ct('m.manage.tokenRemoved'), 'success')
}

// ---------- definições ----------

const PROJECT_ARG = { name: 'projeto', required: true, complete: 'project' as const }

export const manageCommands: CommandDef[] = defineCommands([
  {
    name: 'project',
    aliases: ['projeto', 'projects'],
    group: 'Cadastro',
    subcommands: [
      { name: 'list', aliases: ['ls'], group: 'Cadastro', examples: ['project list'], run: projectList },
      {
        name: 'discover',
        aliases: ['descobrir'],
        group: 'Cadastro',
        examples: ['project discover'],
        run: projectDiscover,
      },
      {
        name: 'import',
        aliases: ['importar'],
        group: 'Cadastro',
        usage: '<projeto...> | --all',
        args: [{ name: 'projeto', variadic: true }],
        options: [{ name: 'all' }],
        examples: ['project import --all', 'project import loja blog'],
        run: projectImport,
      },
      {
        name: 'add',
        aliases: ['cadastrar'],
        group: 'Cadastro',
        usage: '<id-railway> [--name <nome>]',
        args: [{ name: 'id-railway', required: true }],
        options: [{ name: 'name', value: 'nome' }],
        examples: ['project add 0f3c2a1b-1234-4abc-9def-0123456789ab --name Loja'],
        run: projectAdd,
      },
      {
        name: 'show',
        group: 'Cadastro',
        usage: '<projeto>',
        args: [PROJECT_ARG],
        examples: ['project show loja'],
        run: projectShow,
      },
      {
        name: 'edit',
        aliases: ['editar'],
        group: 'Cadastro',
        usage: '<projeto> [--name <nome>] [--description <texto>]',
        args: [PROJECT_ARG],
        options: [
          { name: 'name', value: 'nome' },
          { name: 'description', value: 'texto' },
        ],
        examples: ['project edit loja --name "Loja virtual"', 'project edit loja --description ""'],
        run: projectEdit,
      },
      {
        name: 'sync',
        aliases: ['sincronizar'],
        group: 'Cadastro',
        usage: '<projeto...> | --all',
        args: [{ name: 'projeto', variadic: true, complete: 'project' }],
        options: [{ name: 'all' }],
        examples: ['project sync loja', 'project sync --all'],
        run: projectSync,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        usage: '<projeto> [-y]',
        args: [PROJECT_ARG],
        options: [YES],
        examples: ['project rm blog'],
        run: projectRm,
      },
    ],
  },
  {
    name: 'instance',
    aliases: ['instancia', 'instances'],
    group: 'Cadastro',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Cadastro',
        usage: '[seletor...]',
        args: [{ name: 'seletor', variadic: true, complete: 'selector' }],
        options: [
          { name: 'env', value: 'ambiente', complete: 'environment' },
          { name: 'state', value: 'estado', complete: 'state' },
        ],
        examples: ['instance list loja', 'instance list --state failed'],
        run: instanceList,
      },
      {
        name: 'discover',
        aliases: ['descobrir'],
        group: 'Cadastro',
        usage: '<projeto>',
        args: [PROJECT_ARG],
        examples: ['instance discover loja'],
        run: instanceDiscover,
      },
      {
        name: 'import',
        aliases: ['importar'],
        group: 'Cadastro',
        usage: '<projeto> [serviço@ambiente...] [--all] [--env <ambiente>]',
        args: [
          PROJECT_ARG,
          { name: 'serviço@ambiente', variadic: true },
        ],
        options: [
          { name: 'all' },
          { name: 'env', value: 'ambiente', complete: 'environment' },
        ],
        examples: ['instance import loja --all', 'instance import loja api@production worker@*', 'instance import loja --all --env staging'],
        run: instanceImport,
      },
      {
        name: 'add',
        aliases: ['associar'],
        group: 'Cadastro',
        usage: '<projeto> <serviço@ambiente>',
        args: [PROJECT_ARG, { name: 'serviço@ambiente', required: true }],
        examples: ['instance add loja api@pr-7'],
        run: instanceAdd,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        usage: '<seletor...> [-y]',
        args: [{ name: 'seletor', required: true, variadic: true, complete: 'selector' }],
        options: [{ name: 'env', value: 'ambiente', complete: 'environment' }, YES],
        examples: ['instance rm loja/worker@staging', 'instance rm loja --env staging -y'],
        run: instanceRm,
      },
    ],
  },
  {
    name: 'service',
    aliases: ['servico'],
    group: 'Cadastro',
    subcommands: [
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        usage: '<projeto/serviço> [-y]',
        args: [{ name: 'projeto/serviço', required: true, complete: 'selector' }],
        options: [YES],
        examples: ['service rm loja/worker'],
        run: serviceRm,
      },
    ],
  },
  {
    name: 'credential',
    aliases: ['credencial', 'token'],
    group: 'Configuração',
    subcommands: [
      { name: 'show', group: 'Configuração', examples: ['credential show'], run: credentialShow },
      {
        name: 'set',
        aliases: ['definir'],
        group: 'Configuração',
        usage: '<account|workspace> [--workspace <id>]',
        args: [{ name: 'tipo', required: true, complete: { values: ['account', 'workspace'] } }],
        options: [{ name: 'workspace', value: 'id' }],
        examples: ['credential set account', 'credential set workspace --workspace 0f3c2a1b-…'],
        run: credentialSet,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Configuração',
        usage: '[-y]',
        options: [YES],
        examples: ['credential rm'],
        run: credentialRm,
      },
    ],
  },
])
