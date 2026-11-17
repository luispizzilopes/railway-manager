import { NavLink, Outlet, useLocation } from 'react-router'

import { Icon, type IconName } from '../components/Icon'
import { Console } from '../console/Console'
import { ConsoleProvider, useConsole } from '../console/ConsoleProvider'
import type { Mode } from '../mode'

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Visão geral', icon: 'overview', end: true },
  { to: '/projects', label: 'Projetos', icon: 'projects' },
  { to: '/schedules', label: 'Agendas', icon: 'schedules' },
  { to: '/history', label: 'Histórico', icon: 'history' },
  { to: '/console', label: 'Console', icon: 'console' },
  { to: '/settings', label: 'Configurações', icon: 'settings' },
]

function currentSection(pathname: string): string {
  const match = [...NAV].reverse().find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))
  return match?.label ?? 'Visão geral'
}

/** Painel do console aberto por atalho em qualquer tela (exceto na própria página). */
function ConsolePanel() {
  const { open, setOpen } = useConsole()
  const { pathname } = useLocation()
  if (!open || pathname === '/console') return null
  return (
    <section className="console-drawer" aria-label="Console">
      <header className="console-drawer-head">
        <strong>Console</strong>
        <span className="subtle">Ctrl+` ou Ctrl+K fecha · Esc fecha</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Fechar
        </button>
      </header>
      <Console variant="panel" onClose={() => setOpen(false)} />
    </section>
  )
}

export function Layout({
  onLogout,
  onMode,
  mobile = false,
}: {
  onLogout: () => void
  onMode?: (mode: Mode) => void
  mobile?: boolean
}) {
  const { pathname } = useLocation()
  const nav = mobile ? NAV.filter((item) => item.to !== '/console') : NAV
  return (
    <ConsoleProvider onLogout={onLogout} mode="ui" onMode={onMode}>
      <div className="app">
        <aside className="side">
          <div className="side-brand">
            Railway<span>Manager</span>
          </div>
          <nav className="nav">
            <span className="nav-label">Gerenciar</span>
            {nav.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="side-foot">
            <button type="button" className="btn btn-ghost" onClick={onLogout}>
              <Icon name="logout" />
              Sair
            </button>
          </div>
        </aside>
        <div className="content">
          <header className="topnav">
            <div className="crumbs">
              <span>Railway Manager</span>
              <span className="sep">/</span>
              <strong>{currentSection(pathname)}</strong>
            </div>
            <div className="topnav-right">
              {onMode && !mobile && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title="Usar só a linha de comando (a sessão continua)"
                  onClick={() => onMode('cli')}
                >
                  <Icon name="console" />
                  Modo CLI
                </button>
              )}
              <span className="env-pill">admin</span>
            </div>
          </header>
          <main className="main">
            <Outlet />
          </main>
        </div>
      </div>
      {!mobile && <ConsolePanel />}
    </ConsoleProvider>
  )
}
