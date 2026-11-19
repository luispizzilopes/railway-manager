import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { mockFetch, renderWithProviders } from '@/test/utils'
import { CredentialForm, Settings } from './Settings'

const SECRET = 'tok-segredo-0123456789'

describe('token do Railway', () => {
  it('envia o token e não o mantém no formulário depois do envio', async () => {
    const calls = mockFetch({
      'PUT /api/credential': {
        credential: {
          id: 'c',
          kind: 'account',
          workspace_id: null,
          label: 'Ana',
          masked_suffix: '6789',
          status: 'valid',
          validated_at: null,
          created_at: '',
        },
      },
    })
    renderWithProviders(<CredentialForm replacing={false} />)
    const input = screen.getByLabelText('Token') as HTMLInputElement
    await userEvent.type(input, SECRET)
    expect(input.type).toBe('password')
    await userEvent.click(screen.getByRole('button', { name: 'Validar e salvar' }))

    expect(input.value).toBe('')
    await screen.findByText('Token validado e salvo.')
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ kind: 'account', token: SECRET })
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('token de workspace exige UUID do workspace', async () => {
    const calls = mockFetch({})
    renderWithProviders(<CredentialForm replacing={false} />)
    await userEvent.click(screen.getByLabelText(/Workspace/))
    await userEvent.type(screen.getByLabelText('ID do workspace'), 'abc')
    await userEvent.type(screen.getByLabelText('Token'), SECRET)
    expect(screen.getByText('Informe um UUID válido.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Validar e salvar' })).toBeDisabled()
    expect(calls).toHaveLength(0)
  })

  it('mostra só a máscara de um token cadastrado', async () => {
    mockFetch({
      'GET /api/credential': {
        credential: {
          id: 'c',
          kind: 'workspace',
          workspace_id: 'w',
          label: 'time',
          masked_suffix: 'cdef',
          status: 'invalid',
          validated_at: null,
          created_at: '',
        },
      },
    })
    renderWithProviders(<Settings />)
    expect(await screen.findByText('••••••••cdef')).toBeInTheDocument()
    expect(screen.getByText('Recusado pelo Railway')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Substituir token' })).toBeInTheDocument())
  })
})
