import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { initI18n } from '@/shared/i18n'

// Os testes rodam em pt-BR, como a interface original; os de inglês trocam o idioma explicitamente.
initI18n('pt-BR')

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  initI18n('pt-BR')
})
