import { useTranslation } from 'react-i18next'

import { useTheme } from '@/shared/lib/theme'
import { Button } from '@/shared/ui/Button/Button'
import { Icon } from '@/shared/components/Icon/Icon'

/** Alterna entre claro e escuro; a escolha manual passa a valer no lugar do sistema. */
export function ThemeToggle() {
  const { t } = useTranslation()
  const { theme, setPreference } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setPreference(next)}
      aria-label={next === 'dark' ? t('theme.useDark') : t('theme.useLight')}
      title={next === 'dark' ? t('theme.dark') : t('theme.light')}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </Button>
  )
}
