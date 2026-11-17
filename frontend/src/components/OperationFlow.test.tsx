import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { PLAN } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { OperationFlow } from './OperationFlow'

const DONE = {
  operation: {
    id: 'op-1',
    kind: 'stop',
    scope: 'project',
    trigger: 'manual',
    requested_by: 'admin',
    plan_id: 'plan-1',
    status: 'succeeded',
    created_at: '',
    started_at: null,
    finished_at: null,
  },
  items: [],
  done: true,
}

describe('fluxo de operação', () => {
  it('mostra o plano e não executa nada sem confirmação', async () => {
    const calls = mockFetch({
      'POST /api/operations/plan': PLAN,
      'POST /api/operations': () => ({ status: 202, json: { operation_id: 'op-1' } }),
      'GET /api/operations/op-1': DONE,
    })
    renderWithProviders(
      <OperationFlow kind="stop" target={{ type: 'project', project_id: 'p-1' }} title="Desligar todos" onClose={() => {}} />,
    )
    const entries = await screen.findAllByTestId('plan-entry')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent('Será desligada')
    expect(entries[1]).toHaveTextContent('Ignorada: já está no estado desejado')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/operations/plan'])

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar: desligar 1' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/operations')).toBe(true))
    expect(calls.find((c) => c.url === '/api/operations')?.body).toEqual({ plan_id: 'plan-1' })
    expect(await screen.findByText('Concluída')).toBeInTheDocument()
  })

  it('cancelar não envia a execução', async () => {
    const calls = mockFetch({ 'POST /api/operations/plan': PLAN })
    let closed = false
    renderWithProviders(
      <OperationFlow
        kind="stop"
        target={{ type: 'batch', project_ids: ['p-1'] }}
        title="Lote"
        onClose={() => (closed = true)}
      />,
    )
    await screen.findAllByTestId('plan-entry')
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(closed).toBe(true)
    expect(calls.filter((c) => c.url === '/api/operations')).toHaveLength(0)
  })

  it('nada a fazer desabilita a confirmação', async () => {
    const calls = mockFetch({
      'POST /api/operations/plan': { ...PLAN, entries: PLAN.entries.filter((e) => e.action === 'will_skip') },
    })
    renderWithProviders(
      <OperationFlow kind="stop" target={{ type: 'project', project_id: 'p-1' }} title="x" onClose={() => {}} />,
    )
    expect(await screen.findByText(/Nada a fazer/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirmar/ })).toBeDisabled()
    expect(calls).toHaveLength(1)
  })
})
