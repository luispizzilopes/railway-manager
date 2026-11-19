import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { dashboard } from '@/test/fixtures'
import { type Call, mockFetch, renderWithProviders, sessionAs } from '@/test/utils'

describe('login', () => {
  beforeEach(() => window.localStorage.setItem('rm:mode', 'ui'))

  it('sai da tela de login depois de uma senha correta', async () => {
    let loggedIn = false
    mockFetch({
      'GET /api/session': () =>
        loggedIn
          ? { json: sessionAs('master') }
          : { status: 401, json: { code: 'unauthorized', message: 'autenticação necessária' } },
      'POST /api/session': () => {
        loggedIn = true
        return { status: 204 }
      },
      'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }),
    })
    renderWithProviders(<App />)
    await userEvent.type(await screen.findByLabelText('Usuário'), 'maria')
    await userEvent.type(screen.getByLabelText('Senha'), 'segredo')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Senha')).not.toBeInTheDocument()
  })

  it('volta para a tela de login ao sair', async () => {
    let loggedIn = true
    const calls = mockFetch({
      'GET /api/session': () =>
        loggedIn
          ? { json: sessionAs('master') }
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

describe('escolha entre interface gráfica e CLI', () => {
  const loggedOut = () => ({ status: 401, json: { code: 'unauthorized', message: 'autenticação necessária' } })

  it('pergunta o modo antes do login e lembra a escolha', async () => {
    mockFetch({ 'GET /api/session': loggedOut })
    renderWithProviders(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /Interface gráfica/ }))
    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
    expect(window.localStorage.getItem('rm:mode')).toBe('ui')
  })

  it('no modo CLI o login é pela linha de comando, e ui troca de modo', async () => {
    let loggedIn = false
    const calls = mockFetch({
      'GET /api/session': () => (loggedIn ? { json: sessionAs('master') } : loggedOut()),
      'POST /api/session': (call: Call) => {
        const body = call.body as { username: string; password: string }
        loggedIn = body.username === 'chefe' && body.password === 'segredo'
        return loggedIn ? { status: 204 } : { status: 401, json: { code: 'invalid_credentials', message: 'usuário ou senha incorretos' } }
      },
      'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }),
      'GET /api/schedules': { schedules: [], default_timezone: 'UTC' },
      'GET /api/scheduled-actions': { items: [], total: 0, page: 1, per_page: 50, default_timezone: 'UTC' },
    })
    renderWithProviders(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /Somente linha de comando/ }))

    // Abre já pedindo usuário (visível) e senha (num campo mascarado).
    const user = await screen.findByLabelText(/Usuário/)
    expect(user).toHaveAttribute('type', 'text')
    await userEvent.type(user, 'chefe{Enter}')
    const first = await screen.findByLabelText(/Senha/)
    expect(first).toHaveAttribute('type', 'password')
    await userEvent.type(first, 'errada{Enter}')
    expect(await screen.findByText(/usuário ou senha incorretos/)).toBeInTheDocument()

    const command = screen.getByLabelText(/Comando/)
    await userEvent.type(command, 'status{Enter}')
    expect(await screen.findByText(/faça login primeiro/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/Comando/), 'login{Enter}')
    await userEvent.type(await screen.findByLabelText(/Usuário/), 'chefe{Enter}')
    await userEvent.type(await screen.findByLabelText(/Senha/), 'segredo{Enter}')
    expect(await screen.findByText(/autenticado — digite help/)).toBeInTheDocument()
    expect(screen.getByText(/linha de comando · autenticado/)).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/session')).toHaveLength(2)

    await userEvent.type(screen.getByLabelText(/Comando/), 'ui{Enter}')
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(window.localStorage.getItem('rm:mode')).toBe('ui')

    await userEvent.click(screen.getByRole('button', { name: 'Modo CLI' }))
    expect(await screen.findByText(/linha de comando · autenticado/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Senha/)).not.toBeInTheDocument()
  })

  it('da tela de login dá para passar para a CLI, e da CLI para a interface', async () => {
    window.localStorage.setItem('rm:mode', 'ui')
    mockFetch({ 'GET /api/session': loggedOut })
    renderWithProviders(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /Mudar para linha de comando/ }))
    expect(await screen.findByLabelText(/Usuário/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Interface gráfica' }))
    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
  })
})

describe('celular', () => {
  const asPhone = () =>
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile')

  it('pula a escolha de modo e não oferece a CLI', async () => {
    const ua = asPhone()
    window.localStorage.setItem('rm:mode', 'cli')
    mockFetch({ 'GET /api/session': () => ({ status: 401, json: { code: 'unauthorized', message: 'x' } }) })
    renderWithProviders(<App />)
    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /linha de comando/ })).not.toBeInTheDocument()
    ua.mockRestore()
  })

  it('esconde o console e o modo CLI depois do login', async () => {
    const ua = asPhone()
    mockFetch({
      'GET /api/session': sessionAs('master'),
      'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }),
    })
    renderWithProviders(<App />, { route: '/console' })
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Modo CLI' })).not.toBeInTheDocument()
    ua.mockRestore()
  })
})
