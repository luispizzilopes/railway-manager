import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ManagedUser } from '../api/types'
import { type Call, mockFetch, renderWithProviders, sessionAs } from '../test/utils'
import { Users } from './Users'

const MARIA: ManagedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'maria',
  role: 'operator',
  is_active: true,
  created_at: '2026-11-18T10:00:00Z',
  updated_at: '2026-11-18T10:00:00Z',
}

describe('usuários', () => {
  it('lista, cria, muda papel, desativa, redefine a senha e remove', async () => {
    let users = [MARIA]
    const calls = mockFetch({
      'GET /api/users': () => ({ json: { users } }),
      'POST /api/users': (call: Call) => {
        const body = call.body as { username: string; role: ManagedUser['role'] }
        users = [...users, { ...MARIA, id: 'novo', username: body.username, role: body.role }]
        return { status: 201, json: users[users.length - 1] }
      },
      [`PATCH /api/users/${MARIA.id}`]: { ...MARIA },
      [`POST /api/users/${MARIA.id}/password`]: { status: 204 },
      [`DELETE /api/users/${MARIA.id}`]: { status: 204 },
    })
    renderWithProviders(<Users />)
    const row = (await screen.findAllByTestId('user-row'))[0]
    expect(within(row).getByText('maria')).toBeInTheDocument()
    expect(within(row).getByText('Ativo')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Papel de maria'), 'viewer')
    await userEvent.click(within(row).getByRole('button', { name: 'Desativar' }))
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ role: 'viewer' }, { is_active: false }])

    await userEvent.click(screen.getByRole('button', { name: 'Novo usuário' }))
    await userEvent.type(screen.getByLabelText('Usuário'), 'joao')
    await userEvent.type(screen.getByLabelText('Senha'), 'curta')
    expect(screen.getByRole('button', { name: 'Criar usuário' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Senha'), '-longa')
    await userEvent.selectOptions(screen.getByLabelText('Papel'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: 'Criar usuário' }))
    expect(await screen.findByText('joao')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/users')?.body).toEqual({
      username: 'joao',
      password: 'curta-longa',
      role: 'admin',
    })

    await userEvent.click(within(row).getByRole('button', { name: 'Redefinir senha' }))
    await userEvent.type(screen.getByLabelText('Nova senha'), 'outra-senha-9')
    await userEvent.click(within(screen.getByRole('form', { name: 'Nova senha de maria' })).getByRole('button', { name: 'Redefinir senha' }))
    expect(calls.some((c) => c.url === `/api/users/${MARIA.id}/password`)).toBe(true)

    await userEvent.click(within(row).getByRole('button', { name: 'Remover' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remover' }))
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/users/${MARIA.id}`)).toBe(true)
  })

  it('quem não é master não vê a gestão nem consulta a lista', async () => {
    const calls = mockFetch({ 'GET /api/session': sessionAs('admin', 'ada') })
    renderWithProviders(<Users />)
    expect(await screen.findByText(/Somente o usuário master gerencia usuários/)).toBeInTheDocument()
    expect(calls.some((c) => c.url === '/api/users')).toBe(false)
  })

  it('o formulário não mostra senhas em texto', async () => {
    mockFetch({ 'GET /api/users': { users: [] } })
    renderWithProviders(<Users />)
    await userEvent.click(await screen.findByRole('button', { name: 'Novo usuário' }))
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password')
  })
})
