import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type Call, mockFetch, renderWithProviders } from '@/test/utils'
import { DEFAULT_FILTERS, type LogFilterState } from '@/features/logs/lib/filters'
import { LogsPanel } from './LogsPanel'

const DEPLOYMENTS = {
  deployments: [
    { id: 'd-new', status: 'SUCCESS', created_at: '2026-11-18T09:00:00Z', is_current: true },
    { id: 'd-old', status: 'FAILED', created_at: '2026-11-17T09:00:00Z', is_current: false },
  ],
}

function logs(deployment: string, message: string, isCurrent: boolean) {
  return {
    deployment_id: deployment,
    deployment_status: isCurrent ? 'SUCCESS' : 'FAILED',
    is_current: isCurrent,
    truncated: false,
    lines: [{ timestamp: '2026-11-18T10:00:01.000Z', severity: 'error', message }],
  }
}

function Harness({ initial = DEFAULT_FILTERS }: { initial?: LogFilterState }) {
  const [filters, setFilters] = useState(initial)
  return <LogsPanel instanceId="i-1" filters={filters} onChange={setFilters} fileName="loja-api" />
}

afterEach(() => vi.unstubAllGlobals())

describe('LogsPanel', () => {
  it('escolher um deploy anterior mostra os logs dele e avisa que não é o atual', async () => {
    const calls = mockFetch({
      'GET /api/instances/i-1/deployments': DEPLOYMENTS,
      'GET /api/instances/i-1/logs': (call: Call) =>
        call.url.includes('deployment_id=d-old')
          ? { json: logs('d-old', 'crash antigo', false) }
          : { json: logs('d-new', 'tudo certo', true) },
    })
    renderWithProviders(<Harness />)
    expect(await screen.findByText('tudo certo')).toBeInTheDocument()
    expect(await screen.findByText('Acompanhando ao vivo.')).toBeInTheDocument()

    await userEvent.selectOptions(await screen.findByLabelText('Deploy'), 'd-old')
    expect(await screen.findByText('crash antigo')).toBeInTheDocument()
    expect(screen.getByText(/deploy anterior/)).toBeInTheDocument()
    expect(screen.queryByText('Acompanhando ao vivo.')).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('deployment_id=d-old'))).toBe(true)
  })

  it('build não é acompanhado ao vivo e filtros viram parâmetros da consulta', async () => {
    const calls = mockFetch({
      'GET /api/instances/i-1/deployments': DEPLOYMENTS,
      'GET /api/instances/i-1/logs': logs('d-new', 'npm install', true),
    })
    renderWithProviders(<Harness />)
    await screen.findByText('npm install')
    await userEvent.selectOptions(screen.getByLabelText('Tipo'), 'build')
    await userEvent.click(screen.getByLabelText('ERRO'))
    await userEvent.click(screen.getByLabelText('AVISO'))
    const last = new URL(calls.filter((c) => c.url.includes('/logs')).at(-1)!.url, 'http://x').searchParams
    expect(last.get('type')).toBe('build')
    expect(last.get('severity')).toBe('error,warn')
    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument()
  })

  it('o texto só vai ao Railway ao confirmar com Enter', async () => {
    const calls = mockFetch({
      'GET /api/instances/i-1/deployments': DEPLOYMENTS,
      'GET /api/instances/i-1/logs': logs('d-new', 'conexão recusada', true),
    })
    renderWithProviders(<Harness />)
    await screen.findByText('conexão recusada')
    const before = calls.filter((c) => c.url.includes('/logs')).length
    await userEvent.type(screen.getByLabelText('Filtrar texto'), 'recus')
    expect(calls.filter((c) => c.url.includes('/logs'))).toHaveLength(before)
    await userEvent.type(screen.getByLabelText('Filtrar texto'), '{Enter}')
    const last = calls.filter((c) => c.url.includes('/logs')).at(-1)!
    expect(new URL(last.url, 'http://x').searchParams.get('q')).toBe('recus')
  })

  it('instância sem deploy mostra a mensagem própria', async () => {
    mockFetch({
      'GET /api/instances/i-1/deployments': { deployments: [] },
      'GET /api/instances/i-1/logs': { deployment_id: null, deployment_status: null, is_current: true, truncated: false, lines: [] },
    })
    renderWithProviders(<Harness />)
    expect(await screen.findByText('Nenhum deploy ainda')).toBeInTheDocument()
  })
})
