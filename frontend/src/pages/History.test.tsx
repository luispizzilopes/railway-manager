import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { PROJECT } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { History, filtersFrom } from './History'

const EMPTY = { items: [], total: 0, page: 1, per_page: 50 }

describe('histórico', () => {
  it('lê os filtros da querystring e os envia à API', async () => {
    const calls = mockFetch({ 'GET /api/history': EMPTY, 'GET /api/projects': { projects: [PROJECT] } })
    renderWithProviders(<History />, { route: '/history?kind=stop&result=failed&from=2026-11-01&page=2' })
    await screen.findByText('Nenhuma operação encontrada com esses filtros.')
    const url = calls.find((c) => c.url.startsWith('/api/history'))!.url
    const params = new URLSearchParams(url.split('?')[1])
    expect(Object.fromEntries(params)).toEqual({ kind: 'stop', result: 'failed', from: '2026-11-01', page: '2' })
    expect(screen.getByLabelText('Tipo')).toHaveValue('stop')
  })

  it('aplicar filtros grava na querystring e volta à primeira página', async () => {
    mockFetch({ 'GET /api/history': EMPTY, 'GET /api/projects': { projects: [PROJECT] } })
    renderWithProviders(<History />, { route: '/history?page=3' })
    await screen.findByRole('option', { name: 'loja' })
    await userEvent.selectOptions(screen.getByLabelText('Projeto'), PROJECT.railway_project_id)
    await userEvent.type(screen.getByLabelText('Ambiente'), 'staging')
    await userEvent.selectOptions(screen.getByLabelText('Resultado'), 'failed')
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/history?project=${PROJECT.railway_project_id}&environment=staging&result=failed`,
      ),
    )
  })

  it('origem "ação agendada" no filtro e na linha', async () => {
    const entry = {
      item: {
        id: 'it-1',
        operation_id: 'op-1',
        service_instance_id: 'i-1',
        label: {
          project_id: 'p-1',
          project_name: 'loja',
          railway_project_id: 'rp',
          service_name: 'api',
          railway_service_id: 'rs',
          environment_name: 'production',
          railway_environment_id: 're',
        },
        previous_state: 'running',
        desired_state: 'stopped',
        final_state: 'stopped',
        deployment_id: null,
        result: 'succeeded',
        error_message: null,
        started_at: null,
        finished_at: null,
        duration_ms: 1000,
      },
      kind: 'stop',
      scope: 'batch',
      requested_by: 'agendador',
      trigger: 'scheduled_action',
      schedule_name: null,
      scheduled_action_label: 'todos os projetos',
      operation_status: 'succeeded',
      created_at: '2026-11-17T21:00:05Z',
    }
    const calls = mockFetch({
      'GET /api/history': { items: [entry], total: 1, page: 1, per_page: 50 },
      'GET /api/projects': { projects: [PROJECT] },
    })
    renderWithProviders(<History />, { route: '/history?trigger=scheduled_action' })
    expect(await screen.findByTestId('history-row')).toHaveTextContent('ação agendada: todos os projetos')
    expect(screen.getByLabelText('Origem')).toHaveValue('scheduled_action')
    expect(calls.find((c) => c.url.startsWith('/api/history'))!.url).toContain('trigger=scheduled_action')
  })

  it('filtersFrom ignora vazios e página 1', () => {
    expect(filtersFrom(new URLSearchParams('kind=&page=1&environment=prod'))).toEqual({ environment: 'prod' })
  })
})
