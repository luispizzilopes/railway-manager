import { describe, expect, it } from 'vitest'

import type { Plan, PowerKind } from '@/shared/api/types'
import type { Call } from '@/test/utils'
import { Aborted } from '@/features/console/state/types'
import { consoleHarness, fakeOperation, fakePlan } from '@/features/console/lib/testing'

interface PlanBody {
  kind: PowerKind
  target: { type: string; instance_ids: string[] }
}

/** Rotas de plano/execução/operação coerentes com a visão geral de exemplo. */
function powerRoutes(overrides: { result?: Parameters<typeof fakeOperation>[1]; plan?: (b: PlanBody) => Plan } = {}) {
  const plans = new Map<string, Plan>()
  return {
    'POST /api/operations/plan': (call: Call) => {
      const body = call.body as PlanBody
      const plan = overrides.plan?.(body) ?? fakePlan(body.kind, body.target.instance_ids)
      plans.set(plan.plan_id, plan)
      return { json: plan }
    },
    'POST /api/operations': (call: Call) => {
      const plan = plans.get((call.body as { plan_id: string }).plan_id)!
      return { status: 202, json: { operation_id: `op-${plan.kind}` } }
    },
    'GET /api/operations/op-stop': () => ({ json: fakeOperation(plans.get('plan-stop')!, overrides.result) }),
    'GET /api/operations/op-start': () => ({ json: fakeOperation(plans.get('plan-start')!, overrides.result) }),
  }
}

/** Depois de desligar, o plano de iniciar encontra as instâncias paradas. */
function afterStop(b: PlanBody): Plan {
  const plan = fakePlan(b.kind, b.target.instance_ids)
  if (b.kind === 'stop') return plan
  return {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, current_state: 'stopped', action: 'will_start', reason: null, reason_code: null })),
  }
}

const planned = (h: ReturnType<typeof consoleHarness>) => h.bodies('POST /api/operations/plan') as PlanBody[]

describe('start / stop', () => {
  it('simulação mostra o plano e não executa', async () => {
    const h = consoleHarness(powerRoutes())
    expect(await h.run('stop loja --dry-run')).toBe(true)
    expect(planned(h)[0]).toEqual({
      kind: 'stop',
      target: {
        type: 'instances',
        instance_ids: ['loja/api@production', 'loja/worker@production', 'loja/db@production', 'loja/api@staging', 'loja/worker@staging'],
      },
    })
    expect(h.blocks.some((b) => b.kind === 'plan')).toBe(true)
    expect(h.bodies('POST /api/operations')).toEqual([])
    expect(h.text()).toContain('simulação: nada foi executado')
  })

  it('confirmação negada não executa', async () => {
    const h = consoleHarness(powerRoutes(), { answers: ['n'] })
    expect(await h.run('desligar loja')).toBe(false)
    expect(h.prompts[0]).toMatch(/Desligar 3 instância/)
    expect(h.bodies('POST /api/operations')).toEqual([])
    expect(h.text()).toContain('cancelado')
  })

  it('nada a fazer não pede confirmação', async () => {
    const h = consoleHarness(powerRoutes())
    expect(await h.run('stop loja/worker')).toBe(true)
    expect(h.prompts).toEqual([])
    expect(h.text()).toContain('nada a executar')
  })

  it('stop all exige digitar "tudo" e cria uma única operação', async () => {
    const h = consoleHarness(powerRoutes(), { answers: ['s'] })
    expect(await h.run('stop all')).toBe(false)
    expect(h.prompts[0]).toContain('digite "tudo"')
    expect(h.bodies('POST /api/operations')).toEqual([])

    const ok = consoleHarness(powerRoutes(), { answers: ['tudo'] })
    expect(await ok.run('stop all')).toBe(true)
    expect(planned(ok)).toHaveLength(1)
    expect(planned(ok)[0].target.instance_ids).toHaveLength(8)
    expect(ok.bodies('POST /api/operations')).toEqual([{ plan_id: 'plan-stop' }])
    const progress = ok.blocks.find((b) => b.kind === 'progress')
    expect(progress).toMatchObject({ done: true, status: 'succeeded' })
    expect(ok.invalidated).toBeGreaterThan(0)
  })

  it('start all --env production -y liga só produção, sem confirmação', async () => {
    const h = consoleHarness(powerRoutes())
    expect(await h.run('start all --env production -y')).toBe(true)
    expect(h.prompts).toEqual([])
    expect(planned(h)[0].target.instance_ids).toEqual([
      'loja/api@production',
      'loja/worker@production',
      'loja/db@production',
      'loja-admin/web@production',
      'blog/web@production',
      'blog/worker@production',
    ])
  })

  it('falha parcial interrompe a sequência', async () => {
    const h = consoleHarness(powerRoutes({ result: (e) => (e.service_name === 'db' ? 'failed' : 'succeeded') }))
    expect(await h.run('stop loja@production -y; start blog -y')).toBe(false)
    expect(planned(h).map((p) => p.kind)).toEqual(['stop'])
  })

  it('plano expirado pede para repetir', async () => {
    const h = consoleHarness({
      ...powerRoutes(),
      'POST /api/operations': () => ({ status: 410, json: { code: 'plan_expired', message: 'o plano expirou' } }),
    })
    expect(await h.run('stop loja -y')).toBe(false)
    expect(h.text()).toContain('repita o comando para gerar um novo plano')
  })

  it('--no-wait só mostra o identificador', async () => {
    const h = consoleHarness(powerRoutes())
    expect(await h.run('stop loja -y --no-wait')).toBe(true)
    expect(h.calls.some((c) => c.url.startsWith('/api/operations/op-'))).toBe(false)
    expect(h.text()).toContain('op op-stop')
  })

  it('Ctrl+C solta o acompanhamento sem cancelar a operação', async () => {
    const routes = powerRoutes()
    const h = consoleHarness(
      {
        ...routes,
        'GET /api/operations/op-stop': () => ({ json: { ...fakeOperation(fakePlan('stop', ['loja/api@production'])), done: false } }),
      },
      {
        sleep: async () => {
          throw new Aborted()
        },
      },
    )
    expect(await h.run('stop loja/api@production -y')).toBe(false)
    expect(h.text()).toContain('retome com: op op-stop')
    expect(h.blocks.find((b) => b.kind === 'progress')).toMatchObject({ detached: true })
    expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([])
  })

  it('seletor sem correspondência não chama a API de plano', async () => {
    const h = consoleHarness(powerRoutes())
    expect(await h.run('stop loj')).toBe(false)
    expect(h.text()).toContain("nenhum projeto 'loj' — semelhantes: loja, loja-admin")
    expect(planned(h)).toEqual([])
  })
})

describe('restart', () => {
  it('desliga, liga as que desligaram e resume por instância', async () => {
    const h = consoleHarness(powerRoutes({ plan: afterStop }))
    expect(await h.run('restart loja@production -y')).toBe(true)
    const [stop, start] = planned(h)
    expect(stop.kind).toBe('stop')
    expect(start).toEqual({
      kind: 'start',
      target: { type: 'instances', instance_ids: ['loja/api@production', 'loja/db@production'] },
    })
    const summary = h.blocks.find((b) => b.kind === 'table' && b.title === 'Resumo do reinício')
    expect(summary).toMatchObject({
      rows: [
        ['loja/api@production', { text: 'reiniciada' }, ''],
        ['loja/worker@production', { text: 'ignorada' }, 'não estava ligada'],
        ['loja/db@production', { text: 'reiniciada' }, ''],
      ],
    })
    expect(h.store.get('restart', null)).toBeNull()
  })

  it('pede uma confirmação com aviso de indisponibilidade', async () => {
    const h = consoleHarness(powerRoutes({ plan: afterStop }), { answers: ['s'] })
    expect(await h.run('reiniciar loja/api@production')).toBe(true)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain('ficarão fora do ar')
  })

  it('falha ao desligar não religa', async () => {
    const h = consoleHarness(
      powerRoutes({ plan: afterStop, result: (e) => (e.service_name === 'db' && e.action === 'will_stop' ? 'failed' : 'succeeded') }),
    )
    expect(await h.run('restart loja/db@production loja/api@production -y')).toBe(false)
    expect(planned(h)[1].target.instance_ids).toEqual(['loja/api@production'])
    expect(h.text()).toContain('falhou ao desligar')
  })

  it('registro fica salvo entre as etapas e não pode ser agendado', async () => {
    const h = consoleHarness({
      ...powerRoutes(),
      'GET /api/operations/op-stop': () => ({ json: { ...fakeOperation(fakePlan('stop', ['loja/api@production'])), done: false } }),
    }, {
      sleep: async () => {
        throw new Aborted()
      },
    })
    await h.run('restart loja/api@production -y')
    expect(h.text()).toContain('start loja/api@production -y')

    const scheduled = consoleHarness(powerRoutes())
    expect(await scheduled.run('restart all --at 03:00')).toBe(false)
    expect(scheduled.text()).toContain('restart não pode ser agendado')
    expect(planned(scheduled)).toEqual([])
  })
})

describe('agendamento pontual', () => {
  const actionRoutes = {
    'GET /api/scheduled-actions': { items: [], total: 0, page: 1, per_page: 1, default_timezone: 'America/Sao_Paulo' },
    'POST /api/scheduled-actions': (call: Call) => ({
      status: 201,
      json: { id: '7c1e0000-0000-4000-8000-000000000001', label: 'todos os projetos', status: 'pending', ...(call.body as object) },
    }),
  }

  it('stop all --at 18:00 cria ação dinâmica para hoje', async () => {
    const h = consoleHarness(actionRoutes)
    expect(await h.run('stop all --at 18:00 -y')).toBe(true)
    expect(h.bodies('POST /api/scheduled-actions')).toEqual([
      { kind: 'stop', run_at: '2026-11-17T21:00:00.000Z', target: { type: 'all', environment_name: null }, note: null },
    ])
    expect(h.text()).toContain('hoje 18:00 — em 3h12m')
    expect(h.text()).toContain('ação agendada 7c1e0000 criada')
  })

  it('horário já passado vai para amanhã; projetos inteiros viram alvo de projetos', async () => {
    const h = consoleHarness(actionRoutes, { now: new Date('2026-11-17T22:00:00Z'), answers: ['s'] })
    expect(await h.run('ligar loja --at 07:00 --note "bom dia"')).toBe(true)
    expect(h.prompts[0]).toContain('amanhã 07:00')
    expect(h.bodies('POST /api/scheduled-actions')).toEqual([
      {
        kind: 'start',
        run_at: '2026-11-18T10:00:00.000Z',
        target: { type: 'projects', project_ids: ['p-loja'], environment_name: null },
        note: 'bom dia',
      },
    ])
  })

  it('serviços, exclusões e --in viram instâncias fixas; --state é recusado', async () => {
    const h = consoleHarness(actionRoutes)
    expect(await h.run('stop all --except blog --in 30m -y')).toBe(true)
    const [body] = h.bodies('POST /api/scheduled-actions') as { run_at: string; target: { type: string; instance_ids: string[] } }[]
    expect(body.run_at).toBe('2026-11-17T18:18:00.000Z')
    expect(body.target.type).toBe('instances')
    expect(body.target.instance_ids).toHaveLength(6)

    const env = consoleHarness(actionRoutes)
    await env.run('stop all --env staging --at 18:00 --tz UTC -y')
    expect(env.bodies('POST /api/scheduled-actions')[0]).toMatchObject({
      run_at: '2026-11-17T18:00:00.000Z',
      target: { type: 'all', environment_name: 'staging' },
    })

    const state = consoleHarness(actionRoutes)
    expect(await state.run('stop all --state running --at 18:00')).toBe(false)
    expect(state.text()).toContain('--state não pode ser usada')
  })

  it('at cancel por prefixo', async () => {
    const pending = {
      id: '7c1e0000-0000-4000-8000-000000000001',
      kind: 'stop',
      run_at: '2026-11-17T21:00:00Z',
      target: { type: 'all' },
      note: null,
      label: 'todos os projetos',
      status: 'pending',
      message: null,
      operation_id: null,
      created_at: '2026-11-17T17:00:00Z',
      processed_at: null,
    }
    const h = consoleHarness({
      'GET /api/scheduled-actions': { items: [pending], total: 1, page: 1, per_page: 200, default_timezone: 'America/Sao_Paulo' },
      'POST /api/scheduled-actions/7c1e0000-0000-4000-8000-000000000001/cancel': { ...pending, status: 'cancelled' },
    })
    expect(await h.run('at cancel 7c1e')).toBe(true)
    expect(h.calls.some((c) => c.url.endsWith('/cancel'))).toBe(true)
    expect(h.text()).toContain('ação 7c1e0000 cancelada')

    const list = consoleHarness({
      'GET /api/scheduled-actions': { items: [pending], total: 1, page: 1, per_page: 200, default_timezone: 'America/Sao_Paulo' },
    })
    await list.run('at list')
    expect(list.calls.find((c) => c.url.startsWith('/api/scheduled-actions'))!.url).toContain('status=pending')
    expect(list.text()).toContain('hoje 18:00 — em 3h12m')
  })
})
