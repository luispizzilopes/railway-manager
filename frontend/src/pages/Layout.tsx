import { NavLink, Outlet, useLocation } from 'react-router'

import { Icon, type IconName } from '../components/Icon'
import { Console } from '../console/Console'
import { ConsoleProvider, useConsole } from '../console/ConsoleProvider'

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

function ConsoleToggle() {
  const { open, setOpen } = useConsole()
  const { pathname } = useLocation()
  if (pathname === '/console') return null
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-pressed={open}
      title="Abrir o console (Ctrl+` ou Ctrl+K)"
      onClick={() => setOpen(!open)}
    >
      <Icon name="console" />
      Console
    </button>
  )
}

export function Layout({ onLogout }: { onLogout: () => void }) {
  const { pathname } = useLocation()
  return (
    <ConsoleProvider onLogout={onLogout}>
      <div className="app">
        <aside className="side">
          <div className="side-brand">
            Railway<span>Manager</span>
          </div>
          <nav className="nav">
            <span className="nav-label">Gerenciar</span>
            {NAV.map((item) => (
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
              <ConsoleToggle />
              <span className="env-pill">admin</span>
            </div>
          </header>
          <main className="main">
            <Outlet />
          </main>
        </div>
      </div>
      <ConsolePanel />
    </ConsoleProvider>
  )
}
