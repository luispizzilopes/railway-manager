import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  const MIXED = [
    card({ id: 'a', service_name: 'api', state: 'running' }),
    card({ id: 'b', service_name: 'worker', state: 'stopped' }),
    card({ id: 'c', service_name: 'cron', state: 'failed' }),
  ]

  it('destaca no topo o que exige atenção, com o motivo', async () => {
    mockFetch({ 'GET /api/dashboard': dashboard(MIXED), 'POST /api/dashboard/refresh': { report: { refreshed: 3, not_found: 0, failed: 0 } } })
    renderWithProviders(<Dashboard />)
    const panel = await screen.findByRole('region', { name: 'Requer atenção' })
    expect(within(panel).getByText('cron')).toBeInTheDocument()
    expect(within(panel).queryByText('api')).not.toBeInTheDocument()
    expect(within(panel).getByText(/production · Com falha/)).toBeInTheDocument()
  })

  it('sem pendências mostra só uma confirmação discreta', async () => {
    mockFetch({ 'GET /api/dashboard': dashboard([card({ id: 'a' })]) })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByText('Nenhum serviço requer atenção.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Requer atenção' })).not.toBeInTheDocument()
  })

  it('filtra por estado e por nome, informa a contagem e limpa', async () => {
    mockFetch({ 'GET /api/dashboard': dashboard(MIXED) })
    renderWithProviders(<Dashboard />)
    await screen.findAllByTestId('instance-row')
    expect(screen.getByText('3 serviços')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Filtrar por estado'), 'failed')
    expect(screen.getAllByTestId('instance-row')).toHaveLength(1)
    expect(screen.getByText('1 serviço encontrado')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/?estado=failed')

    await userEvent.type(screen.getByLabelText('Buscar serviço'), 'zzz')
    expect(await screen.findByText('Nenhum serviço encontrado')).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Limpar filtros' })[0])
    expect(screen.getAllByTestId('instance-row')).toHaveLength(3)
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
  })

  it('lê os filtros da URL', async () => {
    mockFetch({ 'GET /api/dashboard': dashboard(MIXED) })
    renderWithProviders(<Dashboard />, { route: '/?q=wor' })
    const rows = await screen.findAllByTestId('instance-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('worker')).toBeInTheDocument()
  })

  it('erro de leitura mostra a mensagem com nova tentativa e mantém a tela', async () => {
    let calls = 0
    mockFetch({
      'GET /api/dashboard': () => {
        calls++
        return calls === 1
          ? { status: 500, json: { code: 'internal', message: 'falha ao ler o painel' } }
          : { json: dashboard([card({ id: 'a' })]) }
      },
    })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('falha ao ler o painel')
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findAllByTestId('instance-row')).toHaveLength(1)
  })

  it('mostra esqueleto enquanto carrega e estado vazio sem projetos', async () => {
    mockFetch({ 'GET /api/dashboard': dashboard([], { projects: [], indicators: { projects: 0, instances: 0, running: 0, sleeping: 0, stopped: 0, failed: 0, other: 0 } }) })
    renderWithProviders(<Dashboard />)
    expect(screen.getByRole('status', { name: 'Carregando a visão geral…' })).toBeInTheDocument()
    expect(await screen.findByText('Nenhum projeto gerenciado')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Importar projetos' })).toHaveAttribute('href', '/projects')
  })
})
