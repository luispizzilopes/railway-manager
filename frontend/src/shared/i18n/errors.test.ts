import { describe, expect, it } from 'vitest'

import { ApiError } from '@/shared/api/client'
import { setLanguage } from './index'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('traduz códigos conhecidos', async () => {
    const error = new ApiError(403, { code: 'forbidden', message: 'seu papel não permite esta ação' })
    expect(errorMessage(error)).toBe('Seu papel não permite esta ação.')
    await setLanguage('en')
    expect(errorMessage(error)).toBe('Your role does not allow this action.')
  })

  it('usa a mensagem do backend para códigos sem tradução', () => {
    expect(errorMessage(new ApiError(400, { code: 'validation', message: 'nome vazio' }))).toBe('nome vazio')
  })

  it('usa o texto genérico sem mensagem', () => {
    expect(errorMessage(undefined)).toBe('Não foi possível concluir a ação.')
  })

  it('interpola o tempo de espera', () => {
    const error = new ApiError(429, { code: 'rate_limited', message: 'x', details: { retry_after_secs: 30 } })
    expect(errorMessage(error)).toContain('30 s')
  })
})
