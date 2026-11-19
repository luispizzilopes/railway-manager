import { useTranslation } from 'react-i18next'

import { LanguageSwitcher } from '@/shared/components/LanguageSwitcher/LanguageSwitcher'
import { Brand } from '@/shared/components/Brand/Brand'
import type { Mode } from '@/features/auth/lib/mode'

/** Antes do login: interface gráfica ou só linha de comando. A escolha fica salva. */
export function ModeChooser({ onChoose }: { onChoose: (mode: Mode) => void }) {
  const { t } = useTranslation('auth')
  return (
    <div className="login">
      <LanguageSwitcher className="login-lang" />
      <div className="card mode-card">
        <div className="login-head">
          <Brand />
          <h1>{t('mode.title')}</h1>
          <p className="muted">{t('mode.subtitle')}</p>
        </div>
        <div className="mode-options">
          <button type="button" className="mode-option" onClick={() => onChoose('ui')}>
            <strong>{t('mode.ui')}</strong>
            <span className="muted">{t('mode.uiHint')}</span>
          </button>
          <button type="button" className="mode-option" onClick={() => onChoose('cli')}>
            <strong>{t('mode.cli')}</strong>
            <span className="muted">{t('mode.cliHint')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
