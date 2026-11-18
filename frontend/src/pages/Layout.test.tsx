import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { mockFetch, renderWithProviders } from '../test/utils'
import { Layout } from './Layout'

describe('layout', () => {
  it('a ordem de tabulação começa pela navegação principal', async () => {
    mockFetch({})
    renderWithProviders(<Layout onLogout={() => undefined} />)
    await userEvent.tab()
    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('link', { name: 'Projetos' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('link', { name: 'Agendas' })).toHaveFocus()
  })

  it('marca a tela atual na navegação', () => {
    mockFetch({})
    renderWithProviders(<Layout onLogout={() => undefined} />, { route: '/history' })
    expect(screen.getByRole('link', { name: 'Histórico' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Visão geral' })).not.toHaveAttribute('aria-current')
  })

  it('o botão de tema alterna e grava a escolha', async () => {
    mockFetch({})
    renderWithProviders(<Layout onLogout={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: /^Tema (escuro|claro)$/ }))
    const chosen = document.documentElement.dataset.theme
    expect(['light', 'dark']).toContain(chosen)
    expect(window.localStorage.getItem('rm:theme')).toBe(chosen)
  })
})
