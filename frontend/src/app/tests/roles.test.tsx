import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { card, dashboard } from '@/test/fixtures'
import { mockFetch, renderWithProviders, sessionAs } from '@/test/utils'
import { Dashboard } from '@/features/dashboard/components/Dashboard'
import { Projects } from '@/features/projects/components/Projects'
import { Settings } from '@/features/settings/components/Settings'

const PROJECTS = { projects: [] }

describe('controles por papel', () => {
  it('viewer só consulta: sem ligar/desligar, sem atualizar e sem atualização automática', async () => {
    const calls = mockFetch({
      'GET /api/session': sessionAs('viewer', 'vera'),
      'GET /api/dashboard': dashboard([card({ service_name: 'api' })]),
    })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByText('api')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desligar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Atualizar estados' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desligar todos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    // Sem permissão, o app nem tenta a atualização automática (daria 403).
    expect(calls.some((c) => c.url === '/api/dashboard/refresh')).toBe(false)
  })

  it('operator liga e desliga e atualiza estados', async () => {
    mockFetch({
      'GET /api/session': sessionAs('operator', 'otto'),
      'GET /api/dashboard': dashboard([card({ service_name: 'api' })]),
    })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByRole('button', { name: 'Desligar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Atualizar estados' })).toBeInTheDocument()
  })

  it('só admin cadastra projetos e troca o token', async () => {
    mockFetch({ 'GET /api/session': sessionAs('operator'), 'GET /api/projects': PROJECTS, 'GET /api/credential': { credential: null } })
    const projects = renderWithProviders(<Projects />)
    expect(await screen.findByText('Nenhum projeto ainda')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Importar da conta' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cadastrar por ID' })).not.toBeInTheDocument()
    projects.unmount()

    renderWithProviders(<Settings />)
    expect(await screen.findByText(/Peça a um administrador para cadastrá-lo/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()
  })

  it('admin vê os controles de gestão', async () => {
    mockFetch({ 'GET /api/session': sessionAs('admin', 'ada'), 'GET /api/projects': PROJECTS })
    renderWithProviders(<Projects />)
    expect(await screen.findByRole('button', { name: 'Cadastrar por ID' })).toBeInTheDocument()
  })

  it('o item Usuários e o nome do usuário aparecem conforme o papel', async () => {
    const routes = { 'GET /api/dashboard': dashboard([], { integration_ready: false, projects: [] }), 'GET /api/users': { users: [] } }
    mockFetch({ ...routes, 'GET /api/session': sessionAs('admin', 'ada') })
    const admin = renderWithProviders(<App />)
    expect(await screen.findByTestId('whoami')).toHaveTextContent('ada · Administrador')
    expect(screen.queryByRole('link', { name: 'Usuários' })).not.toBeInTheDocument()
    admin.unmount()

    mockFetch({ ...routes, 'GET /api/session': sessionAs('master', 'chefe') })
    renderWithProviders(<App />)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Usuários' })).toBeInTheDocument())
    expect(screen.getByTestId('whoami')).toHaveTextContent('chefe · Master')
  })
})
