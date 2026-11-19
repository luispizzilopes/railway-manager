// Texto de erro no idioma ativo: traduz pelo `code` da API; sem tradução, usa a `message` do backend.

import { ApiError } from '@/shared/api/client'
import { i18n } from './index'

/** Códigos de significado fixo, traduzidos pelo catálogo; os demais carregam detalhes na mensagem do backend. */
const CODES = [
  'unauthorized',
  'forbidden',
  'plan_already_used',
  'plan_expired',
  'integration_not_configured',
  'credential_invalid',
  'credential_undecipherable',
  'railway_unavailable',
  'internal',
  'invalid_credentials',
  'too_many_attempts',
  'unsupported_token_kind',
] as const

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') {
      const secs = error.details?.retry_after_secs
      return typeof secs === 'number'
        ? i18n.t('errors:rate_limited', { count: secs })
        : i18n.t('errors:rate_limited_unknown')
    }
    const known = CODES.find((c) => c === error.code)
    if (known) return i18n.t(`errors:${known}`)
    return error.message || i18n.t('errors:generic')
  }
  if (error instanceof Error && error.message) return error.message
  return i18n.t('errors:generic')
}
