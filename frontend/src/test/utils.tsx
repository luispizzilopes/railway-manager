import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'

import type { Role } from '../shared/api/types'

export interface Call {
  method: string
  url: string
  body: unknown
}

type Handler = (call: Call) => { status?: number; json?: unknown }

/** Sessão de teste com o papel dado (por padrão os testes entram como master). */
export const sessionAs = (role: Role, username = 'chefe') => ({ authenticated: true, username, role })

/** Substitui `fetch` por rotas `"MÉTODO /caminho"` (sem querystring) e registra as chamadas.
 *  Sem rota de sessão própria, responde como master logado. */
export function mockFetch(userRoutes: Record<string, Handler | unknown>) {
  const routes: Record<string, Handler | unknown> = { 'GET /api/session': sessionAs('master'), ...userRoutes }
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const call = { method, url, body }
    calls.push(call)
    const key = `${method} ${url.split('?')[0]}`
    const route = routes[key]
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 'not_found', message: `sem mock: ${key}` }), { status: 404 })
    }
    const result = typeof route === 'function' ? (route as Handler)(call) : { json: route }
    const status = result.status ?? (result.json === undefined ? 204 : 200)
    return new Response(status === 204 ? null : JSON.stringify(result.json), { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

export function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

export function renderWithProviders(ui: ReactElement, { route = '/', path = '*' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route
            path={path}
            element={
              <>
                {ui}
                <LocationDisplay />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
