import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import { mockFetch, renderWithProviders } from '../test/utils'
import { Layout } from '../pages/Layout'
import { Console } from './Console'
import { ConsoleProvider } from './ConsoleProvider'
import { browserStore, memoryStore } from './store'
import { sampleDashboard } from './testing'
import type { Store } from './types'

const ROUTES = {
  'GET /api/dashboard': sampleDashboard(),
  'GET /api/schedules': { schedules: [], default_timezone: 'UTC' },
  'GET /api/scheduled-actions': { items: [], total: 0, page: 1, per_page: 50, default_timezone: 'UTC' },
}

function renderConsole(store: Store = memoryStore()) {
  return renderWithProviders(
    <ConsoleProvider onLogout={() => undefined} store={store} pollMs={0}>
      <Console />
    </ConsoleProvider>,
  )
}

const input = () => screen.getByLabelText(/Comando/) as HTMLInputElement

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('console', () => {
  it('abre pelo atalho sem sair da tela atual', async () => {
    mockFetch(ROUTES)
    renderWithProviders(<Layout onLogout={() => undefined} />, { route: '/history' })
    expect(screen.queryByRole('region', { name: 'Console' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: '`', ctrlKey: true })
    const panel = await screen.findByRole('region', { name: 'Console' })
    expect(within(panel).getByLabelText(/Comando/)).toHaveFocus()
    expect(screen.getByTestId('location')).toHaveTextContent('/history')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('region', { name: 'Console' })).not.toBeInTheDocument()
  })

  it('executa, mostra a saída num log e navega no histórico', async () => {
    mockFetch(ROUTES)
    renderConsole()
    await userEvent.type(input(), 'help{Enter}')
    const log = screen.getByRole('log')
    expect(await within(log).findByText(/Comandos do Railway Manager/)).toBeInTheDocument()
    await userEvent.type(input(), 'status{Enter}')
    expect(await within(log).findByText(/3 projeto\(s\)/)).toBeInTheDocument()
    await userEvent.type(input(), '{ArrowUp}')
    expect(input().value).toBe('status')
    await userEvent.type(input(), '{ArrowUp}')
    expect(input().value).toBe('help')
    await userEvent.type(input(), '{ArrowDown}{ArrowDown}')
    expect(input().value).toBe('')
  })

  it('IDs copiáveis, clear e Ctrl+L', async () => {
    mockFetch(ROUTES)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderConsole()
    await userEvent.type(input(), 'instance list loja/api@production{Enter}')
    const id = await screen.findByTitle(/loja\/api@production — clique para copiar/)
    await userEvent.click(id)
    expect(writeText).toHaveBeenCalledWith('loja/api@production')
    await userEvent.type(input(), 'clear{Enter}')
    await waitFor(() => expect(screen.queryByTitle(/clique para copiar/)).not.toBeInTheDocument())
    await userEvent.type(input(), 'help{Enter}')
    expect(await screen.findByText(/Comandos do Railway Manager/)).toBeInTheDocument()
    fireEvent.keyDown(input(), { key: 'l', ctrlKey: true })
    expect(screen.queryByText(/Comandos do Railway Manager/)).not.toBeInTheDocument()
  })

  it('Ctrl+R busca no histórico', async () => {
    mockFetch(ROUTES)
    const store = memoryStore()
    store.set('history', ['stop loja --dry-run', 'status', 'start blog --dry-run'])
    renderConsole(store)
    await userEvent.type(input(), 'dry')
    fireEvent.keyDown(input(), { key: 'r', ctrlKey: true })
    expect(input().value).toBe('start blog --dry-run')
    fireEvent.keyDown(input(), { key: 'r', ctrlKey: true })
    expect(input().value).toBe('stop loja --dry-run')
  })

  it('Tab completa comandos e lista projetos', async () => {
    mockFetch(ROUTES)
    renderConsole()
    await waitFor(() => expect(true).toBe(true))
    await userEvent.type(input(), 'desl{Tab}')
    expect(input().value).toBe('desligar ')
    await userEvent.type(input(), 'lo{Tab}')
    expect(input().value).toBe('desligar loja')
    expect(screen.getByTestId('completion-options')).toHaveTextContent('loja')
    expect(screen.getByTestId('completion-options')).toHaveTextContent('loja-admin')
    await userEvent.type(input(), '/a{Tab}')
    expect(input().value).toBe('desligar loja/api ')
  })

  it('funciona sem armazenamento do navegador', async () => {
    mockFetch(ROUTES)
    const blocked = browserStore(() => {
      throw new Error('bloqueado')
    })
    renderConsole(blocked)
    await userEvent.type(input(), 'alias x="status"{Enter}')
    expect(await screen.findByText('apelido x → status')).toBeInTheDocument()
    await userEvent.type(input(), '{ArrowUp}')
    expect(input().value).toBe('alias x="status"')
  })

  it('não grava linha com token no histórico', async () => {
    mockFetch(ROUTES)
    const store = memoryStore()
    renderConsole(store)
    await userEvent.type(input(), 'credential set account tok-123{Enter}')
    expect(await screen.findByText(/não informe o token/)).toBeInTheDocument()
    expect(store.get('history', [])).toEqual([])
  })

  it('pede confirmação na própria linha', async () => {
    mockFetch({
      ...ROUTES,
      'GET /api/schedules': { schedules: [], default_timezone: 'UTC' },
    })
    renderConsole()
    await userEvent.type(input(), 'project rm blog{Enter}')
    const answer = await screen.findByLabelText(/Remover o projeto blog\?/)
    expect(answer).toHaveFocus()
    await userEvent.type(answer, 'n{Enter}')
    expect(await screen.findByText('cancelado')).toBeInTheDocument()
  })

  it('avisa sobre reinício interrompido com o comando pronto', async () => {
    mockFetch(ROUTES)
    window.localStorage.setItem(
      'rm:console:restart',
      JSON.stringify({
        stopOperationId: 'op-1',
        instanceIds: ['i-1', 'i-2'],
        names: ['loja/api@production', 'loja/db@production'],
        startedAt: '2026-11-17T17:00:00Z',
      }),
    )
    renderWithProviders(<Layout onLogout={() => undefined} />)
    const panel = await screen.findByRole('region', { name: 'Console' })
    expect(within(panel).getByText(/reinício interrompido/)).toHaveTextContent('loja/api@production, loja/db@production')
    expect(within(panel).getByLabelText(/Comando/)).toHaveValue('start i-1 i-2 -y')
    await waitFor(() => expect(window.localStorage.getItem('rm:console:restart')).toBeNull())
  })

  it('401 volta para o login', async () => {
    let authenticated = true
    mockFetch({
      ...ROUTES,
      'GET /api/session': () =>
        authenticated ? { json: { authenticated: true } } : { status: 401, json: { code: 'unauthorized', message: 'x' } },
      'GET /api/railway/projects': () => {
        authenticated = false
        return { status: 401, json: { code: 'unauthorized', message: 'autenticação necessária' } }
      },
    })
    renderWithProviders(<App />, { route: '/console' })
    const field = await screen.findByLabelText(/Comando/)
    await userEvent.type(field, 'project discover{Enter}')
    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
  })
})
