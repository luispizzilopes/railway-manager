import { describe, expect, it } from 'vitest'

import type { ScheduleView } from '@/shared/api/types'
import type { Call } from '@/test/utils'
import { parseDays, parseWindow } from './commands/schedules'
import { consoleHarness, sampleDashboard } from './testing'

function schedule(overrides: Partial<ScheduleView['schedule']> = {}): ScheduleView {
  return {
    schedule: {
      id: 'sc-10000-0000',
      project_id: 'p-loja',
      name: 'Comercial',
      enabled: true,
      timezone: 'America/Sao_Paulo',
      days: [0, 1, 2, 3, 4],
      windows: [{ start: '07:00', end: '12:00' }],
      target: { type: 'project', environment_id: null },
      paused_reason: null,
      created_at: '',
      updated_at: '',
      ...overrides,
    },
    next_runs: [
      { at: '2026-11-17T15:00:00Z', action: 'stop', window: 0 },
      { at: '2026-11-18T10:00:00Z', action: 'start', window: 0 },
    ],
    warnings: [],
  }
}

describe('consulta', () => {
  it('status mostra indicadores e instâncias; com seletor filtra', async () => {
    const h = consoleHarness({})
    expect(await h.run('status')).toBe(true)
    expect(h.text()).toContain('3 projeto(s) · 8 instância(s): 5 ativas')
    const filtered = consoleHarness({})
    await filtered.run('ls --state stopped')
    const table = filtered.blocks.find((b) => b.kind === 'table')
    expect(table && table.kind === 'table' && table.rows).toHaveLength(3)
  })

  it('--json mostra a resposta sem formatação', async () => {
    const dashboard = sampleDashboard()
    const h = consoleHarness({}, { dashboard })
    await h.run('status --json')
    expect(h.blocks).toEqual([{ kind: 'json', value: dashboard }])
  })

  it('refresh, ops e open', async () => {
    const h = consoleHarness({ 'POST /api/dashboard/refresh': { report: { refreshed: 8, not_found: 0, failed: 0 } } })
    await h.run('refresh; ops; open history; open loja')
    expect(h.text()).toContain('8 lidos')
    expect(h.text()).toContain('nenhuma operação recente')
    expect(h.navigated).toEqual(['/history', '/projects/p-loja'])
  })

  it('history converte nomes nos filtros da API', async () => {
    const h = consoleHarness({
      'GET /api/history': { items: [], total: 0, page: 1, per_page: 20 },
      'GET /api/projects/p-loja/instances': {
        instances: [{ service: { id: 's-1', name: 'api', railway_service_id: 'rs-api' }, environment: { name: 'production' } }],
      },
    })
    expect(await h.run('history --project loja --service api --kind stop --trigger scheduled_action --from 2026-11-01')).toBe(true)
    const url = h.calls.find((c) => c.url.startsWith('/api/history'))!.url
    expect(url).toContain('project=00000000-0000-4000-8000-000000000001')
    expect(url).toContain('service=rs-api')
    expect(url).toContain('trigger=scheduled_action')
    expect(await h.run('history --kind restart')).toBe(false)
    expect(h.text()).toContain('--kind inválido')
  })
})

describe('cadastro', () => {
  const discover = {
    workspaces: [
      {
        workspace: { id: 'w', name: 'pessoal' },
        projects: [
          { project: { id: 'rp-loja', name: 'loja', description: null, workspace_id: 'w' }, managed: true },
          { project: { id: 'rp-novo', name: 'novo', description: null, workspace_id: 'w' }, managed: false },
          { project: { id: 'rp-outro', name: 'outro', description: null, workspace_id: 'w' }, managed: false },
        ],
      },
    ],
  }

  it('project import --all importa os não gerenciados', async () => {
    const h = consoleHarness({
      'GET /api/railway/projects': discover,
      'POST /api/projects/import': { imported: [{}, {}], already_managed: [], failed: [] },
    })
    expect(await h.run('project import --all')).toBe(true)
    expect(h.bodies('POST /api/projects/import')).toEqual([{ railway_project_ids: ['rp-novo', 'rp-outro'] }])
    expect(h.text()).toContain('2 projeto(s) importado(s), 0 já gerenciado(s), 0 falha(s)')
  })

  it('project rm pede confirmação mostrando o que será removido', async () => {
    const routes = {
      'GET /api/schedules': { schedules: [], default_timezone: 'UTC' },
      'DELETE /api/projects/p-blog': () => ({ status: 204 }),
    }
    const no = consoleHarness(routes, { answers: ['n'] })
    expect(await no.run('project rm blog')).toBe(false)
    expect(no.text()).toContain('2 instância(s) e 0 agenda(s)')
    expect(no.calls.some((c) => c.method === 'DELETE')).toBe(false)

    const yes = consoleHarness(routes, { answers: ['s'] })
    expect(await yes.run('projeto remover blog')).toBe(true)
    expect(yes.calls.some((c) => c.method === 'DELETE' && c.url === '/api/projects/p-blog')).toBe(true)
  })

  it('instance import por serviço@ambiente', async () => {
    const h = consoleHarness({
      'GET /api/projects/p-loja/railway-instances': {
        environments: [
          {
            environment: { id: 're-prod', name: 'production', is_ephemeral: false },
            instances: [
              { service_id: 'rs-api', service_name: 'api', state: 'running', managed: true },
              { service_id: 'rs-cron', service_name: 'cron', state: 'stopped', managed: false },
            ],
          },
        ],
      },
      'POST /api/projects/p-loja/instances/import': { imported: ['x'], already_managed: [], failed: [] },
    })
    expect(await h.run('instance import loja cron@production')).toBe(true)
    expect(h.bodies('POST /api/projects/p-loja/instances/import')).toEqual([
      { instances: [{ environment_id: 're-prod', service_id: 'rs-cron' }] },
    ])
  })
})

describe('agendas', () => {
  it('dias e janelas', () => {
    expect(parseDays('seg-sex')).toEqual([0, 1, 2, 3, 4])
    expect(parseDays('seg,qua,sex')).toEqual([0, 2, 4])
    expect(parseDays('fds')).toEqual([5, 6])
    expect(parseDays('sex-seg')).toEqual([0, 4, 5, 6])
    expect(parseDays('todos')).toHaveLength(7)
    expect(() => parseDays('xyz')).toThrow(/dia inválido/)
    expect(parseWindow('7:00-12:00')).toEqual({ start: '07:00', end: '12:00' })
    expect(() => parseWindow('07:00')).toThrow(/HH:MM-HH:MM/)
  })

  it('schedule create monta a agenda e mostra as próximas execuções', async () => {
    const h = consoleHarness({
      'GET /api/schedules': { schedules: [], default_timezone: 'America/Sao_Paulo' },
      'POST /api/schedules': (call: Call) => ({ status: 201, json: { ...schedule(), schedule: { ...schedule().schedule, ...(call.body as object) } } }),
    })
    const ok = await h.run('schedule create loja --name Comercial --days seg-sex --window 07:00-12:00 --window 13:00-18:00')
    expect(ok).toBe(true)
    expect(h.bodies('POST /api/schedules')).toEqual([
      {
        project_id: 'p-loja',
        name: 'Comercial',
        timezone: 'America/Sao_Paulo',
        days: [0, 1, 2, 3, 4],
        windows: [
          { start: '07:00', end: '12:00' },
          { start: '13:00', end: '18:00' },
        ],
        target: { type: 'project', environment_id: null },
      },
    ])
    expect(h.text()).toContain('Próximas execuções')
  })

  it('agenda inválida mostra as janelas em conflito', async () => {
    const h = consoleHarness({
      'GET /api/schedules': { schedules: [], default_timezone: 'UTC' },
      'POST /api/schedules': () => ({
        status: 400,
        json: {
          code: 'invalid_schedule',
          message: 'janelas sobrepostas',
          details: { conflicts: [{ start: '07:00', end: '12:00' }, { start: '11:00', end: '15:00' }] },
        },
      }),
    })
    expect(await h.run('schedule create loja@staging --name X --days todos --window 07:00-12:00 --window 11:00-15:00')).toBe(false)
    expect(h.text()).toContain('janelas sobrepostas — janelas em conflito: 07:00–12:00 × 11:00–15:00')
    expect(h.bodies('POST /api/schedules')[0]).toMatchObject({ target: { type: 'project', environment_id: 'p-loja-staging' } })
  })

  it('pause e edit por nome', async () => {
    const h = consoleHarness({
      'GET /api/schedules': { schedules: [schedule()], default_timezone: 'UTC' },
      'POST /api/schedules/sc-10000-0000/pause': schedule({ enabled: false }),
      'PUT /api/schedules/sc-10000-0000': (call: Call) => ({ json: { ...schedule(), schedule: { ...schedule().schedule, ...(call.body as object) } } }),
    })
    expect(await h.run('agenda pausar comercial; schedule edit comercial --window 08:00-18:00 --instances worker@production')).toBe(true)
    expect(h.bodies('PUT /api/schedules/sc-10000-0000')[0]).toMatchObject({
      name: 'Comercial',
      windows: [{ start: '08:00', end: '18:00' }],
      target: { type: 'instances', instance_ids: ['loja/worker@production'] },
    })
  })
})

describe('credencial, apelidos e ajuda', () => {
  it('token na linha é recusado; set usa o campo mascarado', async () => {
    const h = consoleHarness({
      'PUT /api/credential': { credential: { label: 'Ana', masked_suffix: 'abcd' } },
    }, { answers: ['tok-secreto-123'] })
    expect(await h.run('credential set account tok-secreto-123')).toBe(false)
    expect(h.text()).toContain('não informe o token na linha de comando')
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false)

    expect(await h.run('credential set account')).toBe(true)
    expect(h.prompts).toEqual(['Token do Railway (account)'])
    expect(h.bodies('PUT /api/credential')).toEqual([{ kind: 'account', token: 'tok-secreto-123' }])
    expect(h.text()).not.toContain('tok-secreto-123')
  })

  it('apelido para fim de expediente', async () => {
    const h = consoleHarness({
      'POST /api/operations/plan': { plan_id: 'p', kind: 'stop', scope: 'batch', created_at: '', expires_at: '', entries: [], estimate: { mutations: 0, reads_per_poll: 0 } },
    })
    expect(await h.run('alias fimdodia="stop all --except blog -y"')).toBe(true)
    expect(h.aliases).toEqual({ fimdodia: 'stop all --except blog -y' })
    expect(await h.run('fimdodia')).toBe(true)
    const [plan] = h.bodies('POST /api/operations/plan') as { target: { instance_ids: string[] } }[]
    expect(plan.target.instance_ids).toHaveLength(6)
    expect(await h.run('alias stop="start all"')).toBe(false)
    expect(h.text()).toContain('apelidos não substituem comandos')
  })

  it('help stop mostra nomes, opções e exemplos', async () => {
    const h = consoleHarness({})
    expect(await h.run('help stop')).toBe(true)
    const text = h.text()
    expect(text).toContain('também: desligar')
    for (const option of ['--env', '--except', '--state', '--dry-run', '--yes', '--at', '--in', '--tz', '--no-wait', '--json']) {
      expect(text).toContain(option)
    }
    expect(text).toContain('Exemplos:')
    const via = consoleHarness({})
    await via.run('desligar --help')
    expect(via.text()).toBe(text)
  })

  it('comando desconhecido não chama a API', async () => {
    const h = consoleHarness({})
    expect(await h.run('stp loja')).toBe(false)
    expect(h.text()).toContain('comando desconhecido: stp — você quis dizer stop?')
    expect(h.calls).toEqual([])
  })

  it('401 encerra a sessão', async () => {
    const h = consoleHarness({ 'GET /api/dashboard': () => ({ status: 401, json: { code: 'unauthorized', message: 'x' } }) })
    expect(await h.run('status')).toBe(false)
    expect(h.text()).toContain('sessão expirada')
    expect(h.loggedOut).toBe(true)
  })
})
