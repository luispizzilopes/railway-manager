// Modo "somente linha de comando": o console em tela cheia também é a tela de login.

import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Brand } from '@/shared/components/Brand/Brand'
import { Button } from '@/shared/ui/Button/Button'
import { Console } from './Console'
import { ConsoleProvider, useConsole } from '@/features/console/context/ConsoleProvider'
import { COMMANDS } from '@/features/console/commands'
import { requireLogin } from '@/features/console/commands/session'
import type { Mode } from '@/features/auth/lib/mode'

/** Ao abrir sem sessão, já pede a senha. */
function AutoLogin({ authenticated }: { authenticated: boolean }) {
  const { run } = useConsole()
  const started = useRef(false)
  useEffect(() => {
    if (authenticated || started.current) return
    started.current = true
    void run('login')
  }, [authenticated, run])
  return null
}

export function CliApp({
  authenticated,
  onLogin,
  onLogout,
  onMode,
}: {
  authenticated: boolean
  onLogin: () => Promise<void>
  onLogout: () => Promise<void>
  onMode: (mode: Mode) => void
}) {
  const { t } = useTranslation('console')
  const commands = useMemo(() => (authenticated ? COMMANDS : requireLogin(COMMANDS)), [authenticated])
  return (
    <div className="cli-app">
      <header className="cli-head">
        <Brand />
        <span className="subtle">{t('m.ui.cliLabel', { status: authenticated ? t('m.ui.authenticated') : t('m.ui.notAuthenticated') })}</span>
        <Button variant="ghost" size="sm" onClick={() => onMode('ui')}>
          {t('m.ui.graphical')}
        </Button>
      </header>
      <ConsoleProvider
        onLogout={onLogout}
        onLogin={onLogin}
        authenticated={authenticated}
        commands={commands}
        mode="cli"
        onMode={onMode}
      >
        <AutoLogin authenticated={authenticated} />
        <Console
          variant="cli"
          prefetch={authenticated}
          welcome={
            <div className="con-text con-tone-muted">
              {authenticated ? t('m.ui.cliWelcomeIn') : t('m.ui.cliWelcomeOut')}
            </div>
          }
        />
      </ConsoleProvider>
    </div>
  )
}
