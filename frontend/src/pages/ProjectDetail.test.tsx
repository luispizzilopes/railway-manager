import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { dashboard, PROJECT } from '../test/fixtures'
import { mockFetch, renderWithProviders } from '../test/utils'
import { ProjectDetail } from './ProjectDetail'

const ENV = { id: 'e-1', project_id: 'p-1', railway_environment_id: 're', name: 'production', is_ephemeral: false }

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/projects/p-1': { project: PROJECT },
    'GET /api/projects/p-1/instances': { instances: [] },
    'GET /api/projects/p-1/environments': { environments: [ENV] },
    'GET /api/dashboard': dashboard([]),
    ...extra,
  }
}

describe('detalhe do projeto', () => {
  it('troca de aba por teclado e lista ambientes e agendas', async () => {
    mockFetch(routes({ 'GET /api/schedules': { schedules: [], default_timezone: 'America/Sao_Paulo' } }))
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Serviços')]))
    tabs[0].focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('table', { name: 'Ambientes' })).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Ambientes' })).getByText('production')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    expect(await screen.findByText('Nenhuma agenda neste projeto')).toBeInTheDocument()
  })

  it('remover do gerenciamento pede confirmação com o impacto e usa a variante de perigo', async () => {
    mockFetch(routes())
    renderWithProviders(<ProjectDetail />, { route: '/projects/p-1', path: '/projects/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Remover do gerenciamento' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remover do gerenciamento' })
    expect(dialog).toHaveTextContent('Nada é alterado no Railway')
    expect(within(dialog).getByRole('button', { name: 'Remover' })).toHaveClass('btn-danger')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
