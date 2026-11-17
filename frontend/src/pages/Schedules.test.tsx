import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ScheduleView } from '../api/types'
import { PROJECT, card, dashboard } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { Dashboard } from './Dashboard'
import { History } from './History'
import { ScheduleDetail, ScheduleEditor, Schedules, draftErrors } from './Schedules'

function view(overrides: Partial<ScheduleView['schedule']> = {}): ScheduleView {
  return {
    schedule: {
      id: 'sc-1',
      project_id: PROJECT.id,
      name: 'comercial',
      enabled: true,
      timezone: 'UTC',
      days: [0, 1, 2, 3, 4],
      windows: [
        { start: '07:00', end: '12:00' },
        { start: '13:00', end: '18:00' },
      ],
      target: { type: 'project', environment_id: null },
      paused_reason: null,
      created_at: '',
      updated_at: '',
      ...overrides,
    },
    next_runs: [
      { at: '2026-11-20T12:00:00Z', action: 'stop', window: 0 },
      { at: '2026-11-23T07:00:00Z', action: 'start', window: 0 },
    ],
    warnings: [],
  }
}

const routes = {
  'GET /api/schedules': { schedules: [view()], default_timezone: 'America/Sao_Paulo' },
  'GET /api/projects': { projects: [PROJECT] },
  'GET /api/projects/p-1/environments': { environments: [] },
  'GET /api/projects/p-1/instances': { instances: [] },
}

describe('lista de agendas', () => {
  it('mostra dias, janelas, próxima execução e situação', async () => {
    mockFetch(routes)
    renderWithProviders(<Schedules />)
    const row = await screen.findByTestId('schedule-row')
    expect(row).toHaveTextContent('comercial')
    expect(row).toHaveTextContent('loja')
    expect(row).toHaveTextContent('Seg–Sex')
    expect(row).toHaveTextContent('07:00–12:00, 13:00–18:00')
    expect(row).toHaveTextContent('Desligar')
    expect(row).toHaveTextContent('Ativa')
  })

  it('pausar chama a API', async () => {
    const calls = mockFetch({ ...routes, 'POST /api/schedules/sc-1/pause': view({ enabled: false }) })
    renderWithProviders(<Schedules />)
    const row = await screen.findByTestId('schedule-row')
    await userEvent.click(within(row).getByRole('button', { name: 'Pausar' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/schedules/sc-1/pause')).toBe(true))
  })
})

describe('editor de agenda', () => {
  const open = () =>
    renderWithProviders(
      <ScheduleEditor view={null} projects={[PROJECT]} defaultTimezone="America/Sao_Paulo" onSaved={() => {}} onClose={() => {}} />,
    )

  it('nada é enviado com formulário inválido', async () => {
    const calls = mockFetch(routes)
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Criar agenda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Dê um nome à agenda.')
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    expect(draftErrors({ project_id: 'p', name: 'x', timezone: 'UTC', days: [], windows: [{ start: '07:00', end: '07:00' }], targetType: 'instances', environment_id: '', instance_ids: [] })).toEqual([
      'Selecione ao menos um dia da semana.',
      'Janela 1: início e fim iguais.',
      'Selecione ao menos um serviço.',
    ])
  })

  it('envia agenda com duas janelas e dias escolhidos', async () => {
    const calls = mockFetch({ ...routes, 'POST /api/schedules': () => ({ status: 201, json: view() }) })
    open()
    await userEvent.type(screen.getByLabelText('Nome'), 'comercial')
    await userEvent.click(screen.getByRole('button', { name: 'Seg' }))
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar janela' }))
    await userEvent.click(screen.getByRole('button', { name: 'Criar agenda' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      project_id: PROJECT.id,
      name: 'comercial',
      timezone: 'America/Sao_Paulo',
      days: [1, 2, 3, 4],
      windows: [
        { start: '07:00', end: '12:00' },
        { start: '13:00', end: '18:00' },
      ],
      target: { type: 'project', environment_id: null },
    })
  })

  it('mostra a sobreposição recusada pelo backend', async () => {
    mockFetch({
      ...routes,
      'POST /api/schedules': () => ({
        status: 400,
        json: { code: 'invalid_schedule', message: 'as janelas 1 e 2 se sobrepõem', details: { conflicts: [1, 2] } },
      }),
    })
    open()
    await userEvent.type(screen.getByLabelText('Nome'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar janela' }))
    await userEvent.click(screen.getByRole('button', { name: 'Criar agenda' }))
    expect(await screen.findByText('as janelas 1 e 2 se sobrepõem')).toBeInTheDocument()
    expect(screen.getByLabelText('Início da janela 2')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('detalhe da agenda', () => {
  it('lista próximas e últimas execuções com link para a operação', async () => {
    mockFetch({
      'GET /api/schedules/sc-1/runs': {
        items: [
          {
            id: 'r1',
            schedule_id: 'sc-1',
            schedule_name: 'comercial',
            action: 'start',
            scheduled_for: '2026-11-17T07:00:00Z',
            processed_at: '2026-11-17T07:10:00Z',
            status: 'late',
            operation_id: 'op-1',
            message: null,
          },
          {
            id: 'r2',
            schedule_id: 'sc-1',
            schedule_name: 'comercial',
            action: 'stop',
            scheduled_for: '2026-11-16T18:00:00Z',
            processed_at: '2026-11-17T07:10:00Z',
            status: 'missed',
            operation_id: null,
            message: 'servidor indisponível no horário',
          },
        ],
        total: 2,
        page: 1,
        per_page: 20,
      },
    })
    renderWithProviders(<ScheduleDetail view={view()} onClose={() => {}} />)
    expect(screen.getAllByTestId('next-run')).toHaveLength(2)
    const rows = await screen.findAllByTestId('run-row')
    expect(rows[0]).toHaveTextContent('Executado com atraso')
    expect(within(rows[0]).getByRole('button', { name: 'Ver operação' })).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Perdido')
    expect(rows[1]).toHaveTextContent('servidor indisponível no horário')
    expect(within(rows[1]).queryByRole('button')).toBeNull()
  })
})

describe('integração com dashboard e histórico', () => {
  it('card do projeto mostra a próxima ação agendada', async () => {
    const data = dashboard([card({})])
    data.projects[0].next_action = {
      action: 'stop',
      at: new Date(2026, 10, 17, 18, 0).toISOString(),
      schedule_id: 'sc-1',
      schedule_name: 'comercial',
    }
    mockFetch({ 'GET /api/dashboard': data, 'POST /api/dashboard/refresh': { report: { refreshed: 1, not_found: 0, failed: 0 } } })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByTestId('next-action')).toHaveTextContent('Próxima: Desligar às 18:00 · comercial')
  })

  it('filtro de origem vai para a querystring', async () => {
    const empty = { items: [], total: 0, page: 1, per_page: 50 }
    const calls = mockFetch({ 'GET /api/history': empty, 'GET /api/projects': { projects: [PROJECT] } })
    renderWithProviders(<History />, { route: '/history' })
    await screen.findByText('Nenhuma operação encontrada com esses filtros.')
    await userEvent.selectOptions(screen.getByLabelText('Origem'), 'schedule')
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/history?trigger=schedule'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/history?trigger=schedule')).toBe(true))
  })
})

describe('ações agendadas', () => {
  it('lista pendentes e cancela', async () => {
    const pending = {
      id: 'a-1',
      kind: 'stop',
      run_at: '2026-11-17T21:00:00Z',
      target: { type: 'all', environment_name: null },
      note: 'fim do dia',
      label: 'todos os projetos',
      status: 'pending',
      message: null,
      operation_id: null,
      created_at: '2026-11-17T14:00:00Z',
      processed_at: null,
    }
    const calls = mockFetch({
      ...routes,
      'GET /api/scheduled-actions': { items: [pending], total: 1, page: 1, per_page: 50, default_timezone: 'America/Sao_Paulo' },
      'POST /api/scheduled-actions/a-1/cancel': { ...pending, status: 'cancelled' },
    })
    renderWithProviders(<Schedules />)
    const row = await screen.findByTestId('pending-action')
    expect(row).toHaveTextContent('Desligar')
    expect(row).toHaveTextContent('todos os projetos')
    expect(row).toHaveTextContent('18:00')
    expect(row).toHaveTextContent('fim do dia')
    await userEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/scheduled-actions/a-1/cancel')).toBe(true))
  })
})
