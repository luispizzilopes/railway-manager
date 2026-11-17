import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { App } from './App'
import { dashboard } from './test/fixtures'
import { mockFetch, renderWithProviders } from './test/utils'

describe('login', () => {
  it('sai da tela de login depois de uma senha correta', async () => {
    let loggedIn = false
    mockFetch({
      'GET /api/session': () =>
        loggedIn
          ? { json: { authenticated: true } }
          : { status: 401, json: { code: 'unauthorized', message: 'autenticação necessária' } },
      'POST /api/session': () => {
        loggedIn = true
        return { status: 204 }
      },
      'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }),
    })
    renderWithProviders(<App />)
    await userEvent.type(await screen.findByLabelText('Senha'), 'segredo')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Senha')).not.toBeInTheDocument()
  })

  it('volta para a tela de login ao sair', async () => {
    let loggedIn = true
    const calls = mockFetch({
      'GET /api/session': () =>
        loggedIn
          ? { json: { authenticated: true } }
          : { status: 401, json: { code: 'unauthorized', message: 'autenticação necessária' } },
      'DELETE /api/session': () => {
        loggedIn = false
        return { status: 204 }
      },
      'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }),
    })
    renderWithProviders(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Visão geral' })).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/session')).toBe(true)
  })
})
