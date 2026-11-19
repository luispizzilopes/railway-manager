import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { card, dashboard } from '@/test/fixtures'
import { mockFetch, renderWithProviders } from '@/test/utils'
import { Logs } from './Logs'

const LOGS = {
  deployment_id: 'd-1',
  deployment_status: 'SUCCESS',
  is_current: true,
  truncated: false,
  lines: [{ timestamp: '2026-11-18T10:00:01.000Z', severity: 'error', message: 'falhou ao conectar' }],
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/dashboard': dashboard([card({ id: 'i-1', service_name: 'api' }), card({ id: 'i-2', service_name: 'worker' })]),
    'GET /api/instances/i-1/deployments': { deployments: [{ id: 'd-1', status: 'SUCCESS', created_at: null, is_current: true }] },
    'GET /api/instances/i-1/logs': LOGS,
    ...extra,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('tela Logs', () => {
  it('escolher projeto, ambiente e serviço mostra os logs e grava a instância na URL', async () => {
    mockFetch(routes())
    renderWithProviders(<Logs />, { route: '/logs', path: '/logs' })
    expect(await screen.findByText('Escolha um serviço')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Projeto'), 'loja')
    await userEvent.selectOptions(screen.getByLabelText('Ambiente'), 'production')
    await userEvent.selectOptions(screen.getByLabelText('Serviço'), 'api')
    expect(await screen.findByText('falhou ao conectar')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/logs?instance=i-1')
  })

  it('abre por link já com a instância e o filtro aplicados', async () => {
    const calls = mockFetch(routes())
    renderWithProviders(<Logs />, { route: '/logs?instance=i-1&severity=error', path: '/logs' })
    expect(await screen.findByText('falhou ao conectar')).toBeInTheDocument()
    expect(screen.getByLabelText('Projeto')).toHaveValue('p-1')
    expect(screen.getByLabelText('Serviço')).toHaveValue('i-1')
    expect(screen.getByLabelText('ERRO')).toBeChecked()
    const logCall = calls.find((c) => c.url.includes('/logs?'))!
    expect(new URL(logCall.url, 'http://x').searchParams.get('severity')).toBe('error')
  })

  it('instância que não é mais gerenciada mostra aviso e permite escolher outra', async () => {
    mockFetch(routes())
    renderWithProviders(<Logs />, { route: '/logs?instance=sumiu', path: '/logs' })
    expect(await screen.findByText('Serviço não encontrado')).toBeInTheDocument()
    expect(screen.getByLabelText('Projeto')).toBeEnabled()
  })

  it('sem serviços gerenciados orienta a importar', async () => {
    mockFetch(routes({ 'GET /api/dashboard': dashboard([]) }))
    renderWithProviders(<Logs />, { route: '/logs', path: '/logs' })
    expect(await screen.findByText('Nenhum serviço gerenciado')).toBeInTheDocument()
  })
})
