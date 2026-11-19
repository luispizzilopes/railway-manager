import { useTranslation } from 'react-i18next'

import { LANGUAGES, type Language, setLanguage, useLanguage } from '@/shared/i18n'
import { Select } from '@/shared/ui/Field/Field'

/** Seletor de idioma: a troca vale na hora e fica salva neste navegador. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation()
  const language = useLanguage()
  return (
    <Select
      className={className}
      aria-label={t('language.label')}
      value={language}
      onChange={(e) => void setLanguage(e.target.value as Language)}
    >
      {LANGUAGES.map((l) => (
        <option key={l} value={l}>
          {t(`language.${l}`)}
        </option>
      ))}
    </Select>
  )
}
