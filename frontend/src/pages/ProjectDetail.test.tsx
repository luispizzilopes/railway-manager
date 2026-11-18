import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstanceView } from '../api/types'
import { card, dashboard, PROJECT } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { ProjectDetail } from './ProjectDetail'

const ENV = { id: 'e-1', project_id: 'p-1', railway_environment_id: 're', name: 'production', is_ephemeral: false }

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/projects/p-1': { project: PROJECT },
    'GET /api/projects/p-1/instances': { instances: [] },
    'GET /api/projects/p-1/environments': { environments: [ENV] },
    'GET /api/dashboard': dashboard([]),
    ...extra,
  }
}

const VIEW: InstanceView = {
  instance: {
    id: 'i-1',
    service_id: 's-1',
    environment_id: 'e-1',
    observed_state: 'running',
    not_found: false,
    latest_deployment_id: null,
    latest_deployment_status: 'SUCCESS',
    last_observed_at: new Date().toISOString(),
    last_sync_error: null,
  },
  project: PROJECT,
  service: { id: 's-1', project_id: 'p-1', railway_service_id: '00000000-0000-4000-8000-000000000020', name: 'api' },
  environment: ENV,
}

const LOGS = {
  deployment_id: 'd-1',
  deployment_status: 'SUCCESS',
  is_current: true,
  truncated: false,
  lines: [{ timestamp: '2026-11-18T10:00:01.000Z', severity: 'info', message: 'servidor no ar' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('logs na tela do projeto', () => {
  function withLogs() {
    return routes({
      'GET /api/projects/p-1/instances': { instances: [VIEW] },
      'GET /api/dashboard': dashboard([card({ id: 'i-1' })]),
      'GET /api/instances/i-1/deployments': { deployments: [{ id: 'd-1', status: 'SUCCESS', created_at: null, is_current: true }] },
      'GET /api/instances/i-1/logs': LOGS,
    })
  }

  it('abre o painel de logs da instância sem sair da tela e sem afetar ligar/desligar', async () => {
    mockFetch(withLogs())
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Logs de api (production)' }))
    expect(await screen.findByText('servidor no ar')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Logs de api (production)' })).toBeInTheDocument()
    // A lista de serviços continua visível e com as ações de energia.
    expect(screen.getByRole('table', { name: 'Serviços' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Desligar' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByText('servidor no ar')).not.toBeInTheDocument()
  })

  it('"Abrir em tela cheia" leva à tela Logs com a instância e o filtro', async () => {
    mockFetch(withLogs())
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Logs de api (production)' }))
    await screen.findByText('servidor no ar')
    await userEvent.click(screen.getByLabelText('ERRO'))
    const link = screen.getByRole('link', { name: 'Abrir em tela cheia' })
    expect(link).toHaveAttribute('href', '/logs?instance=i-1&severity=error')
  })
})

describe('detalhe do projeto', () => {
  it('troca de aba por teclado e lista ambientes e agendas', async () => {
    mockFetch(routes({ 'GET /api/schedules': { schedules: [], default_timezone: 'America/Sao_Paulo' } }))
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Serviços')]))
    tabs[0].focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('table', { name: 'Ambientes' })).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Ambientes' })).getByText('production')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    expect(await screen.findByText('Nenhuma agenda neste projeto')).toBeInTheDocument()
  })

  it('remover do gerenciamento pede confirmação com o impacto e usa a variante de perigo', async () => {
    mockFetch(routes())
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Remover do gerenciamento' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remover do gerenciamento' })
    expect(dialog).toHaveTextContent('Nada é alterado no Railway')
    expect(within(dialog).getByRole('button', { name: 'Remover' })).toHaveClass('btn-danger')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
