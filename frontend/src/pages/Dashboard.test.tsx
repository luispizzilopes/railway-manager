import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { card, dashboard } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { Dashboard } from './Dashboard'

describe('dashboard', () => {
  it('distingue dados desatualizados e indisponíveis dos atuais', async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString()
    mockFetch({
      'GET /api/dashboard': dashboard([
        card({ id: 'a', service_name: 'api', freshness: 'fresh' }),
        card({ id: 'b', service_name: 'worker', state: 'stopped', freshness: 'stale', last_observed_at: old }),
        card({ id: 'c', service_name: 'cron', state: 'failed', freshness: 'unavailable', last_sync_error: 'Railway indisponível' }),
      ]),
      'POST /api/dashboard/refresh': { report: { refreshed: 3, not_found: 0, failed: 0 } },
    })
    renderWithProviders(<Dashboard />)
    const rows = await screen.findAllByTestId('instance-row')
    expect(rows.map((r) => r.dataset.freshness)).toEqual(['fresh', 'stale', 'unavailable'])

    expect(within(rows[0]).getByText(/^Lido/)).toBeInTheDocument()
    expect(within(rows[1]).getByText(/Desatualizado/)).toBeInTheDocument()
    expect(within(rows[1]).getByText('Desligado')).toHaveAttribute('data-freshness', 'stale')
    expect(within(rows[2]).getByText(/Indisponível · última leitura/)).toBeInTheDocument()
    expect(within(rows[2]).getByText('Com falha')).toHaveAttribute('data-freshness', 'unavailable')
  })

  it('sem credencial: orienta o cadastro e desabilita ações', async () => {
    mockFetch({
      'GET /api/dashboard': dashboard([card({})], {
        integration_ready: false,
        alerts: [{ code: 'no_credential', message: 'Nenhum token do Railway configurado.' }],
      }),
    })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByText('Nenhum token do Railway configurado.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configurar token' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('button', { name: 'Desligar todos' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Desligar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Atualizar estados' })).toBeDisabled()
  })

  it('mostra os indicadores', async () => {
    mockFetch({
      'GET /api/dashboard': dashboard([card({})], {
        indicators: { projects: 2, instances: 5, running: 3, sleeping: 1, stopped: 1, failed: 1, other: 0 },
      }),
      'POST /api/dashboard/refresh': { report: { refreshed: 1, not_found: 0, failed: 0 } },
    })
    renderWithProviders(<Dashboard />)
    const running = await screen.findByTestId('stat-Ativos')
    expect(running).toHaveTextContent('3')
    expect(running).toHaveTextContent('1 dormindo')
    expect(screen.getByTestId('stat-Serviços monitorados')).toHaveTextContent('5')
  })
})
