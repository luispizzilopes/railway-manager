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

  it('filtersFrom ignora vazios e página 1', () => {
    expect(filtersFrom(new URLSearchParams('kind=&page=1&environment=prod'))).toEqual({ environment: 'prod' })
  })
})
