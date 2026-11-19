// A interface em inglês: login, painel, toast de sucesso, erro da API e o console.

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Login } from '@/features/auth/components/Login'
import { CredentialForm } from '@/features/settings/components/Settings'
import { Dashboard } from '@/features/dashboard/components/Dashboard'
import { Console } from '@/features/console/components/Console'
import { ConsoleProvider } from '@/features/console/context/ConsoleProvider'
import { memoryStore } from '@/features/console/state/store'
import { sampleDashboard } from '@/features/console/lib/testing'
import { ToastProvider } from '@/shared/ui/Toast/Toast'
import { card, dashboard } from '@/test/fixtures'
import { mockFetch, renderWithProviders } from '@/test/utils'
import { setLanguage } from './index'

describe('interface em inglês', () => {
  it('login', async () => {
    await setLanguage('en')
    renderWithProviders(<Login onLogin={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('erro de login usa a tradução do código da API', async () => {
    await setLanguage('en')
    mockFetch({ 'POST /api/session': () => ({ status: 401, json: { code: 'invalid_credentials', message: 'usuário ou senha incorretos' } }) })
    renderWithProviders(<Login onLogin={() => undefined} />)
    await userEvent.type(screen.getByLabelText('Username'), 'ana')
    await userEvent.type(screen.getByLabelText('Password'), 'errada')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.')
  })

  it('painel: rótulos, estados e tempo relativo', async () => {
    await setLanguage('en')
    mockFetch({
      'GET /api/dashboard': dashboard([card({ id: 'a', service_name: 'api' }), card({ id: 'b', service_name: 'worker', state: 'stopped' })]),
    })
    renderWithProviders(<Dashboard />)
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    const rows = await screen.findAllByTestId('instance-row')
    expect(within(rows[0]).getByText('Running')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Stopped')).toBeInTheDocument()
    expect(within(rows[1]).getByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh states' })).toBeInTheDocument()
  })

  it('toast de sucesso no idioma ativo', async () => {
    await setLanguage('en')
    mockFetch({ 'PUT /api/credential': { credential: { id: 'c', kind: 'account', workspace_id: null, label: 'Ana', masked_suffix: '6789', status: 'valid', validated_at: null, created_at: '' } } })
    renderWithProviders(
      <ToastProvider>
        <CredentialForm replacing={false} />
      </ToastProvider>,
    )
    await userEvent.type(screen.getByLabelText('Token'), 'tok-123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Validate and save' }))
    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Token validated and saved.')
  })

  it('toast de erro traduz o código da API', async () => {
    await setLanguage('en')
    mockFetch({ 'PUT /api/credential': () => ({ status: 403, json: { code: 'forbidden', message: 'seu papel não permite esta ação' } }) })
    renderWithProviders(
      <ToastProvider>
        <CredentialForm replacing={false} />
      </ToastProvider>,
    )
    await userEvent.type(screen.getByLabelText('Token'), 'tok-123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Validate and save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role does not allow this action.')
  })

  it('console: ajuda em inglês e os mesmos nomes de comando', async () => {
    await setLanguage('en')
    mockFetch({ 'GET /api/dashboard': sampleDashboard() })
    renderWithProviders(
      <ConsoleProvider onLogout={() => undefined} store={memoryStore()} pollMs={0}>
        <Console />
      </ConsoleProvider>,
    )
    await userEvent.type(screen.getByLabelText(/Command/), 'help{Enter}')
    const log = screen.getByRole('log')
    expect(await within(log).findByText(/Railway Manager commands/)).toBeInTheDocument()
    expect(within(log).getByText('stops instances (interrupts the active deployments)')).toBeInTheDocument()
    expect(within(log).getAllByText('stop').length).toBeGreaterThan(0)
    await waitFor(() => expect(log).toHaveTextContent('Power'))
  })

  it('console: erro de comando em inglês', async () => {
    await setLanguage('en')
    mockFetch({ 'GET /api/dashboard': sampleDashboard() })
    renderWithProviders(
      <ConsoleProvider onLogout={() => undefined} store={memoryStore()} pollMs={0}>
        <Console />
      </ConsoleProvider>,
    )
    await userEvent.type(screen.getByLabelText(/Command/), 'stopp all{Enter}')
    expect(await screen.findByText(/unknown command: stopp/)).toBeInTheDocument()
  })
})

describe('troca de idioma pelo console', () => {
  it('language en troca a interface e language sem argumento mostra o atual', async () => {
    await setLanguage('pt-BR')
    mockFetch({ 'GET /api/dashboard': sampleDashboard() })
    renderWithProviders(
      <ConsoleProvider onLogout={() => undefined} store={memoryStore()} pollMs={0}>
        <Console />
      </ConsoleProvider>,
    )
    await userEvent.type(screen.getByLabelText(/Comando/), 'language en{Enter}')
    expect(await screen.findByText('language changed to en')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/Command/), 'language{Enter}')
    expect(await screen.findByText(/current language: en/)).toBeInTheDocument()
  })
})
