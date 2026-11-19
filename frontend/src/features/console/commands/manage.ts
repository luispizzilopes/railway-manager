// Cadastro: projetos, instâncias, serviços e credencial.

import type { CredentialKind, DiscoveredEnvironment, ProjectImportReport, InstanceImportReport } from '@/shared/api/types'
import { SYNC_LABEL } from '@/shared/lib/format'
import { flag, str } from '../parse'
import { findProject, instanceName, parseSelector, resolveSelectors } from '../selectors'
import type { CommandDef, Ctx, Invocation } from '../types'
import { CommandError } from '../types'
import { YES, confirmOrCancel, note, show, when } from './shared'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function importReport(ctx: Ctx, report: ProjectImportReport | InstanceImportReport, what: string) {
  const imported = report.imported.length
  show(ctx, report, {
    kind: 'text',
    tone: report.failed.length ? 'warn' : 'success',
    text: [
      `${imported} ${what} importado(s), ${report.already_managed.length} já gerenciado(s), ${report.failed.length} falha(s)`,
      ...report.failed.map((f) => `  ✗ ${f.id}: ${f.reason}`),
    ].join('\n'),
  })
}

// ---------- projetos ----------

async function projectList(ctx: Ctx) {
  const { projects } = await ctx.api.projects()
  show(ctx, projects, {
    kind: 'table',
    columns: ['Projeto', 'Nome no Railway', 'Sincronização', 'Última', 'ID', 'ID Railway'],
    rows: projects.map((p) => [
      p.display_name ?? p.name,
      p.name,
      SYNC_LABEL[p.sync_status],
      when(p.last_synced_at),
      { id: p.id },
      { id: p.railway_project_id },
    ]),
  })
  if (projects.length === 0) note(ctx, 'nenhum projeto gerenciado — veja project discover e project import --all')
}

async function discovered(ctx: Ctx) {
  return (await ctx.api.discoverProjects()).workspaces.flatMap((w) =>
    w.projects.map((p) => ({ ...p, workspace: w.workspace?.name ?? 'pessoal' })),
  )
}

async function projectDiscover(ctx: Ctx) {
  const all = await discovered(ctx)
  show(ctx, all, {
    kind: 'table',
    columns: ['Workspace', 'Projeto', 'Gerenciado', 'ID Railway'],
    rows: all.map((p) => [
      p.workspace,
      p.project.name,
      p.managed ? { text: 'sim', tone: 'success' } : { text: 'não', tone: 'muted' },
      { id: p.project.id },
    ]),
  })
}

async function projectImport(ctx: Ctx, inv: Invocation) {
  const all = await discovered(ctx)
  let ids: string[]
  if (flag(inv, 'all')) {
    if (inv.args.length) throw new CommandError('use nomes/IDs ou --all, não os dois')
    ids = all.filter((p) => !p.managed).map((p) => p.project.id)
    if (ids.length === 0) {
      note(ctx, 'todos os projetos acessíveis já são gerenciados', 'info')
      return
    }
  } else {
    if (inv.args.length === 0) throw new CommandError('informe projetos (nome ou ID Railway) ou --all')
    ids = inv.args.map((text) => {
      if (UUID.test(text)) return text
      const found = all.filter((p) => p.project.name.toLowerCase() === text.toLowerCase())
      if (found.length !== 1) {
        throw new CommandError(
          found.length ? `'${text}' existe em mais de um workspace: use o ID Railway` : `nenhum projeto '${text}' no Railway — veja project discover`,
        )
      }
      return found[0].project.id
    })
  }
  const report = await ctx.api.importProjects(ids)
  ctx.invalidate()
  importReport(ctx, report, 'projeto(s)')
  return report.failed.length === 0
}

async function projectAdd(ctx: Ctx, inv: Invocation) {
  const { project } = await ctx.api.createProject(inv.args[0], str(inv, 'name'))
  ctx.invalidate()
  show(ctx, project, { kind: 'text', tone: 'success', text: `projeto ${project.display_name ?? project.name} cadastrado (${project.id})` })
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
    columns: ['Campo', 'Valor'],
    rows: [
      ['Nome no Railway', project.name],
      ['Descrição', project.description ?? ''],
      ['Sincronização', `${SYNC_LABEL[project.sync_status]} · ${when(project.last_synced_at)}`],
      ['ID', { id: project.id }],
      ['ID Railway', { id: project.railway_project_id }],
      ['Agendas', schedules.map((s) => s.schedule.name).join(', ') || '—'],
      ['Próxima ação', entry.next_action ? `${entry.next_action.action} ${when(entry.next_action.at)}` : '—'],
    ],
  })
  ctx.print({
    kind: 'table',
    title: 'Instâncias',
    columns: ['Serviço', 'Ambiente', 'Estado', 'ID'],
    rows: entry.environments.flatMap(({ environment, instances }) =>
      instances.map((i) => [i.service_name, environment.name, { state: i.state }, { id: i.id }]),
    ),
  })
}

async function projectEdit(ctx: Ctx, inv: Invocation) {
  const name = str(inv, 'name')
  const description = str(inv, 'description')
  if (name === undefined && description === undefined) throw new CommandError('informe --name e/ou --description')
  const { project } = findProject(await ctx.dashboard(true), inv.args[0])
  const updated = await ctx.api.editProject(project.id, {
    display_name: name === undefined ? project.display_name : name || null,
    description: description === undefined ? project.description : description || null,
  })
  ctx.invalidate()
  show(ctx, updated, { kind: 'text', tone: 'success', text: `projeto ${updated.project.display_name ?? updated.project.name} atualizado` })
}

async function projectSync(ctx: Ctx, inv: Invocation) {
  const dashboard = await ctx.dashboard(true)
  if (!flag(inv, 'all') && inv.args.length === 0) throw new CommandError('informe projetos ou --all')
  const projects = flag(inv, 'all') ? dashboard.projects : inv.args.map((a) => findProject(dashboard, a))
  let ok = true
  for (const { project } of projects) {
    const { report, project: synced } = await ctx.api.syncProject(project.id)
    ok &&= synced.sync_status === 'ok'
    show(ctx, report, {
      kind: 'text',
      tone: synced.sync_status === 'ok' ? 'success' : 'warn',
      text: `${synced.display_name ?? synced.name}: ${SYNC_LABEL[synced.sync_status]} — ${report.refreshed} lidas, ${report.not_found} não encontradas, ${report.failed} falhas`,
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
    `remover ${name} do gerenciamento apaga localmente ${instances} instância(s) e ${schedules.length} agenda(s); nada é alterado no Railway e o histórico é preservado`,
    'warn',
  )
  if (!(await confirmOrCancel(ctx, inv, `Remover o projeto ${name}?`))) return false
  await ctx.api.removeProject(entry.project.id)
  ctx.invalidate()
  note(ctx, `projeto ${name} removido do gerenciamento`, 'success')
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
    columns: ['Instância', 'Estado', 'ID'],
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
    columns: ['Ambiente', 'Serviço', 'Estado', 'Gerenciada'],
    rows: rows.map((r) => [
      r.environment + (r.ephemeral ? ' (efêmero)' : ''),
      r.service_name,
      { state: r.state },
      r.managed ? { text: 'sim', tone: 'success' } : { text: 'não', tone: 'muted' },
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
  if (found.length === 0) throw new CommandError(`nenhuma instância '${text}' no Railway para ${project} — veja instance discover ${project}`)
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
    if (specs.length) throw new CommandError('use serviço@ambiente ou --all, não os dois')
    chosen = rows.filter((r) => !r.managed && !r.ephemeral)
  } else {
    if (specs.length === 0) throw new CommandError('informe serviço@ambiente (ex.: api@production) ou --all')
    chosen = specs.flatMap((s) => matchDiscovered(rows, s, project.name))
  }
  if (chosen.length === 0) {
    note(ctx, 'nada a importar: as instâncias já são gerenciadas', 'info')
    return
  }
  const report = await ctx.api.importInstances(
    project.id,
    chosen.map((r) => ({ environment_id: r.environment_id, service_id: r.service_id })),
  )
  ctx.invalidate()
  importReport(ctx, report, 'instância(s)')
  return report.failed.length === 0
}

async function instanceAdd(ctx: Ctx, inv: Invocation) {
  const [projectText, spec] = inv.args
  const { project, environments } = await discoverIn(ctx, projectText)
  const found = matchDiscovered(flatDiscovered(environments), spec, project.name)
  if (found.length !== 1) throw new CommandError(`'${spec}' corresponde a ${found.length} instâncias: seja específico (serviço@ambiente)`)
  const { instance } = await ctx.api.associateInstance(project.id, {
    environment_id: found[0].environment_id,
    service_id: found[0].service_id,
  })
  ctx.invalidate()
  show(ctx, instance, {
    kind: 'text',
    tone: 'success',
    text: `instância ${instance.service.name}@${instance.environment.name} associada a ${project.display_name ?? project.name}`,
  })
}

async function instanceRm(ctx: Ctx, inv: Invocation) {
  const targets = resolveSelectors(await ctx.dashboard(true), inv.args, { env: str(inv, 'env') })
  note(ctx, targets.map(instanceName).join('\n'))
  if (!(await confirmOrCancel(ctx, inv, `Remover ${targets.length} instância(s) do gerenciamento (nada muda no Railway)?`))) {
    return false
  }
  for (const t of targets) await ctx.api.removeInstance(t.id)
  ctx.invalidate()
  note(ctx, `${targets.length} instância(s) removida(s) do gerenciamento`, 'success')
}

async function serviceRm(ctx: Ctx, inv: Invocation) {
  const sel = parseSelector(inv.args[0])
  if (sel.all || !sel.service || sel.environment) throw new CommandError('use projeto/serviço (ex.: loja/worker)')
  const { project } = findProject(await ctx.dashboard(true), sel.project!)
  const views = (await ctx.api.instances(project.id)).instances.filter(
    (v) => v.service.name.toLowerCase() === sel.service!.toLowerCase() || v.service.id === sel.service,
  )
  if (views.length === 0) throw new CommandError(`nenhum serviço '${sel.service}' gerenciado em ${project.name}`)
  const service = views[0].service
  note(ctx, `remove ${service.name} e suas ${views.length} instância(s) gerenciada(s) (${views.map((v) => v.environment.name).join(', ')})`, 'warn')
  if (!(await confirmOrCancel(ctx, inv, `Remover o serviço ${project.name}/${service.name} do gerenciamento?`))) return false
  await ctx.api.removeService(service.id)
  ctx.invalidate()
  note(ctx, `serviço ${service.name} removido do gerenciamento`, 'success')
}

// ---------- credencial ----------

async function credentialShow(ctx: Ctx) {
  const { credential } = await ctx.api.credential()
  if (!credential) {
    show(ctx, null, { kind: 'text', tone: 'warn', text: 'nenhum token cadastrado — use credential set <account|workspace>' })
    return
  }
  show(ctx, credential, {
    kind: 'table',
    columns: ['Tipo', 'Conta', 'Final', 'Situação', 'Validado', 'Workspace'],
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
  if (kind !== 'account' && kind !== 'workspace') throw new CommandError("tipo inválido: use 'account' ou 'workspace'")
  const workspace = str(inv, 'workspace')
  if (kind === 'workspace' && !workspace) throw new CommandError('tokens de workspace exigem --workspace <id>')
  const token = await ctx.secret(`Token do Railway (${kind})`)
  if (!token) {
    note(ctx, 'cancelado')
    return false
  }
  const { credential } = await ctx.api.saveCredential({ kind, token, workspace_id: workspace })
  ctx.invalidate()
  note(ctx, `token validado e salvo: ${credential.label} (…${credential.masked_suffix})`, 'success')
}

async function credentialRm(ctx: Ctx, inv: Invocation) {
  if (!(await confirmOrCancel(ctx, inv, 'Remover o token do Railway? Operações e agendas deixarão de funcionar.'))) return false
  await ctx.api.removeCredential()
  ctx.invalidate()
  note(ctx, 'token removido', 'success')
}

// ---------- definições ----------

const PROJECT_ARG = { name: 'projeto', required: true, help: 'nome ou ID', complete: 'project' as const }

export const manageCommands: CommandDef[] = [
  {
    name: 'project',
    aliases: ['projeto', 'projects'],
    group: 'Cadastro',
    summary: 'projetos gerenciados',
    subcommands: [
      { name: 'list', aliases: ['ls'], group: 'Cadastro', summary: 'lista os projetos gerenciados', examples: ['project list'], run: projectList },
      {
        name: 'discover',
        aliases: ['descobrir'],
        group: 'Cadastro',
        summary: 'lista os projetos acessíveis pelo token no Railway',
        examples: ['project discover'],
        run: projectDiscover,
      },
      {
        name: 'import',
        aliases: ['importar'],
        group: 'Cadastro',
        summary: 'importa projetos do Railway (nome ou ID) ou todos os não gerenciados',
        usage: '<projeto...> | --all',
        args: [{ name: 'projeto', variadic: true, help: 'nome ou ID Railway' }],
        options: [{ name: 'all', help: 'importa todos os projetos acessíveis ainda não gerenciados' }],
        examples: ['project import --all', 'project import loja blog'],
        run: projectImport,
      },
      {
        name: 'add',
        aliases: ['cadastrar'],
        group: 'Cadastro',
        summary: 'cadastra um projeto pelo ID Railway',
        usage: '<id-railway> [--name <nome>]',
        args: [{ name: 'id-railway', required: true, help: 'Railway Project ID' }],
        options: [{ name: 'name', value: 'nome', help: 'nome de exibição' }],
        examples: ['project add 0f3c2a1b-1234-4abc-9def-0123456789ab --name Loja'],
        run: projectAdd,
      },
      {
        name: 'show',
        group: 'Cadastro',
        summary: 'detalhes, instâncias e agendas de um projeto',
        usage: '<projeto>',
        args: [PROJECT_ARG],
        examples: ['project show loja'],
        run: projectShow,
      },
      {
        name: 'edit',
        aliases: ['editar'],
        group: 'Cadastro',
        summary: 'altera nome de exibição e descrição (vazio limpa)',
        usage: '<projeto> [--name <nome>] [--description <texto>]',
        args: [PROJECT_ARG],
        options: [
          { name: 'name', value: 'nome', help: 'nome de exibição ("" volta ao nome do Railway)' },
          { name: 'description', value: 'texto', help: 'descrição ("" limpa)' },
        ],
        examples: ['project edit loja --name "Loja virtual"', 'project edit loja --description ""'],
        run: projectEdit,
      },
      {
        name: 'sync',
        aliases: ['sincronizar'],
        group: 'Cadastro',
        summary: 'sincroniza nome, ambientes e estados com o Railway',
        usage: '<projeto...> | --all',
        args: [{ name: 'projeto', variadic: true, help: 'nome ou ID', complete: 'project' }],
        options: [{ name: 'all', help: 'sincroniza todos' }],
        examples: ['project sync loja', 'project sync --all'],
        run: projectSync,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        summary: 'remove o projeto do gerenciamento (nada muda no Railway)',
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
    summary: 'instâncias gerenciadas (serviço × ambiente)',
    subcommands: [
      {
        name: 'list',
        aliases: ['ls'],
        group: 'Cadastro',
        summary: 'lista instâncias gerenciadas com IDs',
        usage: '[seletor...]',
        args: [{ name: 'seletor', variadic: true, help: 'padrão: all', complete: 'selector' }],
        options: [
          { name: 'env', value: 'ambiente', help: 'só um ambiente', complete: 'environment' },
          { name: 'state', value: 'estado', help: 'só neste estado', complete: 'state' },
        ],
        examples: ['instance list loja', 'instance list --state failed'],
        run: instanceList,
      },
      {
        name: 'discover',
        aliases: ['descobrir'],
        group: 'Cadastro',
        summary: 'lista as instâncias do projeto no Railway e se já são gerenciadas',
        usage: '<projeto>',
        args: [PROJECT_ARG],
        examples: ['instance discover loja'],
        run: instanceDiscover,
      },
      {
        name: 'import',
        aliases: ['importar'],
        group: 'Cadastro',
        summary: 'importa instâncias do Railway',
        usage: '<projeto> [serviço@ambiente...] [--all] [--env <ambiente>]',
        args: [
          PROJECT_ARG,
          { name: 'serviço@ambiente', variadic: true, help: 'aceita * e IDs Railway' },
        ],
        options: [
          { name: 'all', help: 'importa todas as não gerenciadas (exceto ambientes efêmeros)' },
          { name: 'env', value: 'ambiente', help: 'só deste ambiente', complete: 'environment' },
        ],
        examples: ['instance import loja --all', 'instance import loja api@production worker@*', 'instance import loja --all --env staging'],
        run: instanceImport,
      },
      {
        name: 'add',
        aliases: ['associar'],
        group: 'Cadastro',
        summary: 'associa uma instância específica',
        usage: '<projeto> <serviço@ambiente>',
        args: [PROJECT_ARG, { name: 'serviço@ambiente', required: true, help: 'nomes ou IDs Railway' }],
        examples: ['instance add loja api@pr-7'],
        run: instanceAdd,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        summary: 'remove instâncias do gerenciamento (nada muda no Railway)',
        usage: '<seletor...> [-y]',
        args: [{ name: 'seletor', required: true, variadic: true, help: 'instâncias a remover', complete: 'selector' }],
        options: [{ name: 'env', value: 'ambiente', help: 'só um ambiente', complete: 'environment' }, YES],
        examples: ['instance rm loja/worker@staging', 'instance rm loja --env staging -y'],
        run: instanceRm,
      },
    ],
  },
  {
    name: 'service',
    aliases: ['servico'],
    group: 'Cadastro',
    summary: 'serviços gerenciados',
    subcommands: [
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Cadastro',
        summary: 'remove o serviço e todas as suas instâncias do gerenciamento',
        usage: '<projeto/serviço> [-y]',
        args: [{ name: 'projeto/serviço', required: true, help: 'ex.: loja/worker', complete: 'selector' }],
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
    summary: 'token do Railway',
    subcommands: [
      { name: 'show', group: 'Configuração', summary: 'mostra o token cadastrado (mascarado)', examples: ['credential show'], run: credentialShow },
      {
        name: 'set',
        aliases: ['definir'],
        group: 'Configuração',
        summary: 'cadastra ou substitui o token (digitado num campo mascarado)',
        usage: '<account|workspace> [--workspace <id>]',
        args: [{ name: 'tipo', required: true, help: 'account ou workspace', complete: { values: ['account', 'workspace'] } }],
        options: [{ name: 'workspace', value: 'id', help: 'ID do workspace (obrigatório para tokens de workspace)' }],
        details: 'O token nunca é aceito como argumento e nunca vai para o histórico de comandos.',
        examples: ['credential set account', 'credential set workspace --workspace 0f3c2a1b-…'],
        run: credentialSet,
      },
      {
        name: 'rm',
        aliases: ['remover'],
        group: 'Configuração',
        summary: 'remove o token',
        usage: '[-y]',
        options: [YES],
        examples: ['credential rm'],
        run: credentialRm,
      },
    ],
  },
]
