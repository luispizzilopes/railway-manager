// Modo "somente linha de comando": o console em tela cheia também é a tela de login.

import { useEffect, useMemo, useRef } from 'react'

import { Brand } from '../components/Brand'
import { Button } from '../components/ui/Button'
import { Console } from '../console/Console'
import { ConsoleProvider, useConsole } from '../console/ConsoleProvider'
import { COMMANDS } from '../console/commands'
import { requireLogin } from '../console/commands/session'
import type { Mode } from '../mode'

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
  const commands = useMemo(() => (authenticated ? COMMANDS : requireLogin(COMMANDS)), [authenticated])
  return (
    <div className="cli-app">
      <header className="cli-head">
        <Brand />
        <span className="subtle">linha de comando · {authenticated ? 'autenticado' : 'não autenticado'}</span>
        <Button variant="ghost" size="sm" onClick={() => onMode('ui')}>
          Interface gráfica
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
              Railway Manager — linha de comando. {authenticated ? 'Digite help para ver os comandos' : 'Digite login para entrar'}
              {' '}e ui para usar a interface gráfica.
            </div>
          }
        />
      </ConsoleProvider>
    </div>
  )
}
