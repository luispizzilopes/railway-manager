// Visão geral de exemplo para os testes do console.
//   loja (p-loja): api, worker, db @ production; api, worker @ staging
//   loja-admin (p-adm): web @ production
//   blog (p-blog): web, worker @ production

import { api } from '../api/client'
import type { Dashboard, ObservedState, OperationDetail, Plan, PlanEntry, PowerKind } from '../api/types'
import { card } from '../test/fixtures'
import { mockFetch } from '../test/utils'
import { COMMANDS } from './commands'
import { runLine } from './engine'
import { flatten } from './selectors'
import { memoryStore } from './store'
import type { Block, Ctx } from './types'

type Spec = [service: string, env: string, state: ObservedState]

function project(id: string, name: string, n: number, instances: Spec[]): Dashboard['projects'][number] {
  const envs = [...new Set(instances.map(([, env]) => env))]
  return {
    project: {
      id,
      credential_id: 'c-1',
      railway_project_id: `00000000-0000-4000-8000-00000000000${n}`,
      name,
      display_name: null,
      description: null,
      created_at: '2026-11-01T00:00:00Z',
      last_synced_at: '2026-11-17T00:00:00Z',
      sync_status: 'ok',
    },
    environments: envs.map((env) => ({
      environment: {
        id: `${id}-${env}`,
        project_id: id,
        railway_environment_id: `00000000-0000-4000-9000-0000000000${n}${env.length}`,
        name: env,
        is_ephemeral: false,
      },
      instances: instances
        .filter(([, e]) => e === env)
        .map(([service, , state]) => card({ id: `${name}/${service}@${env}`, service_name: service, state })),
    })),
    next_action: null,
  }
}

export function sampleDashboard(): Dashboard {
  const projects = [
    project('p-loja', 'loja', 1, [
      ['api', 'production', 'running'],
      ['worker', 'production', 'stopped'],
      ['db', 'production', 'running'],
      ['api', 'staging', 'running'],
      ['worker', 'staging', 'stopped'],
    ]),
    project('p-adm', 'loja-admin', 2, [['web', 'production', 'running']]),
    project('p-blog', 'blog', 3, [
      ['web', 'production', 'stopped'],
      ['worker', 'production', 'running'],
    ]),
  ]
  return {
    generated_at: '2026-11-17T14:48:00Z',
    integration_ready: true,
    credential: null,
    indicators: { projects: 3, instances: 8, running: 5, sleeping: 0, stopped: 3, failed: 0, other: 0 },
    projects,
    recent_operations: [],
    alerts: [],
    rate_limit: { paused_until: null, remaining: null, limit: null },
  }
}

// ---------- harness de comandos ----------


/** Plano coerente com a visão geral de exemplo: desligar quem está ligado, iniciar quem está parado. */
export function fakePlan(kind: PowerKind, ids: string[], dashboard = sampleDashboard()): Plan {
  const all = flatten(dashboard)
  const entries: PlanEntry[] = ids.map((id) => {
    const i = all.find((x) => x.id === id)!
    const acts = kind === 'stop' ? i.state === 'running' : i.state === 'stopped'
    return {
      instance_id: id,
      project_id: i.projectId,
      project_name: i.projectName,
      service_name: i.service,
      environment_name: i.environment,
      current_state: i.state,
      action: acts ? (kind === 'stop' ? 'will_stop' : 'will_start') : 'will_skip',
      deployments: acts ? 1 : 0,
      reason_code: acts ? null : 'already_in_desired_state',
      reason: acts ? null : 'já está no estado desejado',
      fails: false,
    }
  })
  return {
    plan_id: `plan-${kind}`,
    kind,
    scope: 'batch',
    created_at: '2026-11-17T17:48:00Z',
    expires_at: '2026-11-17T17:53:00Z',
    entries,
    estimate: { mutations: entries.filter((e) => e.action !== 'will_skip').length, reads_per_poll: 1 },
  }
}

/** Operação concluída com o resultado informado para cada instância do plano. */
export function fakeOperation(plan: Plan, result: (e: PlanEntry) => 'succeeded' | 'failed' | 'skipped' = (e) =>
  e.action === 'will_skip' ? 'skipped' : 'succeeded'): OperationDetail {
  const items = plan.entries.map((e, n) => ({
    id: `item-${n}`,
    operation_id: `op-${plan.kind}`,
    service_instance_id: e.instance_id,
    label: {
      project_id: e.project_id,
      project_name: e.project_name,
      railway_project_id: 'rp',
      service_name: e.service_name,
      railway_service_id: 'rs',
      environment_name: e.environment_name,
      railway_environment_id: 're',
    },
    previous_state: e.current_state,
    desired_state: plan.kind === 'stop' ? ('stopped' as const) : ('running' as const),
    final_state: null,
    deployment_id: null,
    result: result(e),
    error_message: result(e) === 'failed' ? 'erro do Railway' : null,
    started_at: null,
    finished_at: null,
    duration_ms: 10,
  }))
  const failed = items.filter((i) => i.result === 'failed').length
  return {
    operation: {
      id: `op-${plan.kind}`,
      kind: plan.kind,
      scope: 'batch',
      trigger: 'manual',
      requested_by: 'admin',
      plan_id: plan.plan_id,
      status: failed === 0 ? 'succeeded' : failed === items.length ? 'failed' : 'partially_failed',
      created_at: '2026-11-17T17:48:00Z',
      started_at: null,
      finished_at: null,
    },
    items,
    done: true,
  }
}

export interface HarnessOptions {
  answers?: (string | null)[]
  now?: Date
  dashboard?: ReturnType<typeof sampleDashboard>
  sleep?: () => Promise<void>
}

/** Executa linhas do console sobre a API real com `fetch` simulado. */
export function consoleHarness(routes: Record<string, unknown>, options: HarnessOptions = {}) {
  const dashboard = options.dashboard ?? sampleDashboard()
  const calls = mockFetch({ 'GET /api/dashboard': dashboard, ...routes })
  const blocks: Block[] = []
  const prompts: string[] = []
  const navigated: string[] = []
  const answers = [...(options.answers ?? [])]
  const store = memoryStore()
  let aliases: Record<string, string> = {}
  let invalidated = 0
  let loggedOut = false
  const controller = new AbortController()

  const makeCtx = (json: boolean): Ctx => ({
    api,
    print: (b) => String(blocks.push(b) - 1),
    update: (id, b) => void (blocks[Number(id)] = b),
    clear: () => void blocks.splice(0),
    confirm: async (question, o) => {
      prompts.push(question)
      const a = (answers.shift() ?? '')?.toLowerCase()
      return o?.word ? a === o.word : a === 's'
    },
    secret: async (label) => {
      prompts.push(label)
      return answers.shift() ?? null
    },
    signal: controller.signal,
    sleep: options.sleep ?? (async () => undefined),
    now: () => options.now ?? new Date('2026-11-17T17:48:00Z'),
    navigate: (to) => void navigated.push(to),
    invalidate: () => void invalidated++,
    dashboard: () => api.dashboard(),
    store,
    commands: COMMANDS,
    aliases,
    setAliases: (next) => void (aliases = next),
    json,
    logout: async () => void (loggedOut = true),
    authenticated: true,
    login: async (password) => api.login(password),
    mode: 'ui',
    setMode: () => undefined,
    pollMs: 0,
  })

  const text = () =>
    blocks
      .map((b) => {
        if (b.kind === 'text' || b.kind === 'error') return 'text' in b ? b.text : b.message
        if (b.kind === 'table') return [b.title ?? '', ...b.rows.map((r) => r.map((c) => (c && typeof c === 'object' ? ('text' in c ? c.text : 'id' in c ? c.id : '') : String(c ?? ''))).join(' | '))].join('\n')
        return ''
      })
      .join('\n')

  return {
    run: (line: string) => runLine(line, makeCtx),
    blocks,
    calls,
    prompts,
    navigated,
    store,
    text,
    get aliases() {
      return aliases
    },
    get invalidated() {
      return invalidated
    },
    get loggedOut() {
      return loggedOut
    },
    abort: () => controller.abort(),
    /** Corpos das chamadas a um método/caminho. */
    bodies: (key: string) => calls.filter((c) => `${c.method} ${c.url.split('?')[0]}` === key).map((c) => c.body),
  }
}
