import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { mockFetch, renderWithProviders, sessionAs } from '@/test/utils'
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

  describe('celular', () => {
    it('mostra até Histórico na barra e deixa o resto em "Mais"', async () => {
      mockFetch({ 'GET /api/session': sessionAs('master', 'chefe') })
      renderWithProviders(<Layout onLogout={() => undefined} mobile />)
      for (const name of ['Visão geral', 'Projetos', 'Agendas', 'Histórico']) {
        expect(screen.getByRole('link', { name })).toBeInTheDocument()
      }
      for (const name of ['Logs', 'Usuários', 'Configurações']) {
        expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
      }
      await userEvent.click(screen.getByRole('button', { name: 'Mais' }))
      for (const name of ['Logs', 'Usuários', 'Configurações']) {
        expect(await screen.findByRole('link', { name })).toBeInTheDocument()
      }
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('link', { name: 'Logs' })).not.toBeInTheDocument()
    })

    it('Usuários só aparece em "Mais" para o master, e o nome não fica no cabeçalho', async () => {
      mockFetch({ 'GET /api/session': sessionAs('admin', 'ada') })
      renderWithProviders(<Layout onLogout={() => undefined} mobile />)
      await userEvent.click(screen.getByRole('button', { name: 'Mais' }))
      expect(await screen.findByRole('link', { name: 'Configurações' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Usuários' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('whoami')).not.toBeInTheDocument()
    })

    it('"Mais" fica marcado quando a tela atual está dentro dele', async () => {
      mockFetch({})
      renderWithProviders(<Layout onLogout={() => undefined} mobile />, { route: '/logs' })
      expect(screen.getByRole('button', { name: 'Mais' })).toHaveClass('active')
    })
  })
})
