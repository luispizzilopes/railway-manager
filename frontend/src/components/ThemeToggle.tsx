import { useTheme } from '../theme'
import { Button } from './ui/Button'
import { Icon } from './Icon'

/** Alterna entre claro e escuro; a escolha manual passa a valer no lugar do sistema. */
export function ThemeToggle() {
  const { theme, setPreference } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setPreference(next)}
      aria-label={`Usar tema ${next === 'dark' ? 'escuro' : 'claro'}`}
      title={`Tema ${next === 'dark' ? 'escuro' : 'claro'}`}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </Button>
  )
}
