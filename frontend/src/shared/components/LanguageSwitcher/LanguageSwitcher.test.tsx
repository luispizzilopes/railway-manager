import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { i18n } from '@/shared/i18n'
import { Login } from '@/features/auth/components/Login'
import { renderWithProviders } from '@/test/utils'

describe('LanguageSwitcher', () => {
  it('troca os textos do login sem recarregar e salva a escolha', async () => {
    renderWithProviders(<Login onLogin={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Idioma' }), 'en')

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(window.localStorage.getItem('rm:lang')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(i18n.language).toBe('en')
  })
})
