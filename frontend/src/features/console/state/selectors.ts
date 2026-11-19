// Seletores de alvo resolvidos sobre a visão geral (instâncias gerenciadas).
//
//   seletor := 'all' ['@' amb] | proj ['/' serv] ['@' amb]
//   proj, serv, amb := nome | id | padrão com '*'

import type { Dashboard, ObservedState } from '@/shared/api/types'
import { similar } from '@/features/console/engine/parse'
import { CommandError } from './types'

export interface ResolvedInstance {
  id: string
  projectId: string
  projectName: string
  railwayProjectId: string
  service: string
  environmentId: string
  environment: string
  state: ObservedState
  busy: boolean
}

export interface Selector {
  raw: string
  all: boolean
  project?: string
  service?: string
  environment?: string
}

export interface SelectOptions {
  env?: string
  state?: string
  except?: string[]
}

export const STATES: ObservedState[] = [
  'running',
  'stopped',
  'sleeping',
  'transitioning',
  'failed',
  'awaiting_approval',
  'unknown',
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSelector(raw: string): Selector {
  const text = raw.trim()
  if (!text) throw new CommandError('seletor vazio')
  const at = text.lastIndexOf('@')
  const head = at === -1 ? text : text.slice(0, at)
  const environment = at === -1 ? undefined : text.slice(at + 1)
  if (environment !== undefined && !environment) throw new CommandError(`ambiente vazio no seletor '${raw}'`)
  const slash = head.indexOf('/')
  const project = slash === -1 ? head : head.slice(0, slash)
  const service = slash === -1 ? undefined : head.slice(slash + 1)
  if (!project) throw new CommandError(`projeto vazio no seletor '${raw}'`)
  if (service !== undefined && !service) throw new CommandError(`serviço vazio no seletor '${raw}'`)
  if (project.toLowerCase() === 'all') {
    if (service !== undefined) throw new CommandError(`'all' não aceita serviço: use '*/${service}'`)
    return { raw, all: true, environment }
  }
  return { raw, all: false, project, service, environment }
}

const hasWildcard = (s: string) => s.includes('*')

function pattern(text: string): RegExp {
  const escaped = text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** `true` se `text` corresponde a algum dos nomes/IDs. */
function matches(text: string, candidates: (string | null | undefined)[]): boolean {
  if (hasWildcard(text)) {
    const re = pattern(text)
    return candidates.some((c) => c != null && re.test(c))
  }
  const lower = text.toLowerCase()
  return candidates.some((c) => c != null && c.toLowerCase() === lower)
}

/** Todas as instâncias gerenciadas, achatadas. */
export function flatten(dashboard: Dashboard): ResolvedInstance[] {
  return dashboard.projects.flatMap(({ project, environments }) =>
    environments.flatMap(({ environment, instances }) =>
      instances.map((card) => ({
        id: card.id,
        projectId: project.id,
        projectName: project.display_name || project.name,
        railwayProjectId: project.railway_project_id,
        service: card.service_name,
        environmentId: environment.id,
        environment: environment.name,
        state: card.state,
        busy: card.busy,
      })),
    ),
  )
}

export function projectNames(dashboard: Dashboard): string[] {
  return dashboard.projects.map(({ project }) => project.display_name || project.name)
}

function projectCandidates(dashboard: Dashboard, id: string) {
  const p = dashboard.projects.find((x) => x.project.id === id)?.project
  return p ? [p.display_name, p.name, p.id, p.railway_project_id] : []
}

function noMatch(kind: string, text: string, pool: string[], scope = ''): CommandError {
  const close = similar(text.replace(/\*/g, ''), [...new Set(pool)])
  const hint = close.length ? ` — semelhantes: ${close.join(', ')}` : pool.length ? '' : ' — nenhum cadastrado'
  return new CommandError(`nenhum ${kind} '${text}'${scope}${hint}`)
}

function selectOne(dashboard: Dashboard, all: ResolvedInstance[], s: Selector): ResolvedInstance[] {
  let pool = all
  if (!s.all && s.project) {
    // Instância pelo ID, sozinha.
    if (UUID.test(s.project) && !s.service && !s.environment) {
      const byInstance = all.filter((i) => i.id.toLowerCase() === s.project!.toLowerCase())
      if (byInstance.length) return byInstance
    }
    const project = s.project
    pool = pool.filter((i) => matches(project, projectCandidates(dashboard, i.projectId)))
    if (pool.length === 0 && !dashboard.projects.some((p) => matches(project, projectCandidates(dashboard, p.project.id)))) {
      throw noMatch('projeto', project, projectNames(dashboard))
    }
    if (s.service) {
      const service = s.service
      const before = pool
      pool = pool.filter((i) => matches(service, [i.service, i.id]))
      if (pool.length === 0) {
        const scope = hasWildcard(project) ? '' : ` em ${before[0]?.projectName ?? project}`
        throw noMatch('serviço', service, before.map((i) => i.service), scope)
      }
    }
  }
  if (s.environment) {
    const environment = s.environment
    const before = pool
    pool = pool.filter((i) => matches(environment, [i.environment, i.environmentId]))
    if (pool.length === 0) throw noMatch('ambiente', environment, before.map((i) => i.environment), ` para '${s.raw}'`)
  }
  if (pool.length === 0) throw new CommandError(`nenhuma instância gerenciada para '${s.raw}'`)
  return pool
}

/** União dos seletores → `--env` → `--state` → `--except`, sem repetições, em ordem estável. */
export function resolveSelectors(
  dashboard: Dashboard,
  selectors: string[],
  options: SelectOptions = {},
): ResolvedInstance[] {
  if (selectors.length === 0) throw new CommandError('informe ao menos um seletor (ex.: all, loja, loja/api@production)')
  const all = flatten(dashboard)
  const picked = new Set<string>()
  for (const raw of selectors) for (const i of selectOne(dashboard, all, parseSelector(raw))) picked.add(i.id)
  let result = all.filter((i) => picked.has(i.id))

  if (options.env) {
    const env = options.env
    const before = result
    result = result.filter((i) => matches(env, [i.environment, i.environmentId]))
    if (result.length === 0) throw noMatch('ambiente', env, before.map((i) => i.environment), ' no alvo')
  }
  if (options.state) {
    const state = options.state.toLowerCase()
    if (!STATES.includes(state as ObservedState)) {
      throw new CommandError(`estado inválido: '${options.state}' — use ${STATES.join(', ')}`)
    }
    result = result.filter((i) => i.state === state)
  }
  for (const raw of options.except ?? []) {
    const excluded = new Set(selectOne(dashboard, all, parseSelector(raw)).map((i) => i.id))
    result = result.filter((i) => !excluded.has(i.id))
  }
  if (result.length === 0) throw new CommandError('nenhuma instância restou no alvo depois dos filtros')
  return result
}

/** Rótulo curto de uma instância: `projeto/serviço@ambiente`. */
export function instanceName(i: ResolvedInstance): string {
  return `${i.projectName}/${i.service}@${i.environment}`
}

/** Projeto único pelo nome/ID (comandos que agem sobre um projeto). */
export function findProject(dashboard: Dashboard, text: string) {
  const found = dashboard.projects.filter(({ project }) =>
    matches(text, [project.display_name, project.name, project.id, project.railway_project_id]),
  )
  if (found.length === 0) throw noMatch('projeto', text, projectNames(dashboard))
  if (found.length > 1) {
    throw new CommandError(`'${text}' corresponde a vários projetos: ${found.map((p) => p.project.name).join(', ')}`)
  }
  return found[0]
}
