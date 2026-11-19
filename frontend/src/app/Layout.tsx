import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { Brand } from '../shared/components/Brand'
import { CommandPalette, type PaletteItem } from '../shared/components/CommandPalette'
import { Icon, type IconName } from '../shared/components/Icon'
import { ThemeToggle } from '../shared/components/ThemeToggle'
import { Button } from '../shared/ui/Button'
import { Console } from '../features/console/Console'
import { ConsoleProvider, useConsole } from '../features/console/ConsoleProvider'
import type { Mode } from '../features/auth/mode'
import { ROLE_LABEL, useSession } from '../features/auth/session'
import { useTheme } from '../shared/lib/theme'

type NavItem = { to: string; label: string; icon: IconName; end?: boolean; master?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Visão geral', icon: 'overview', end: true },
  { to: '/projects', label: 'Projetos', icon: 'projects' },
  { to: '/schedules', label: 'Agendas', icon: 'schedules' },
  { to: '/history', label: 'Histórico', icon: 'history' },
  { to: '/logs', label: 'Logs', icon: 'logs' },
  { to: '/console', label: 'Console', icon: 'console' },
  { to: '/users', label: 'Usuários', icon: 'users', master: true },
  { to: '/settings', label: 'Configurações', icon: 'settings' },
]

/** Telas que ficam na barra do celular; as demais vão para o menu "Mais". */
const MOBILE_PRIMARY = ['/', '/projects', '/schedules', '/history']

/** Navegação do celular: abas principais e um menu "Mais" com o restante. */
function MobileNav({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const primary = items.filter((i) => MOBILE_PRIMARY.includes(i.to))
  const more = items.filter((i) => !MOBILE_PRIMARY.includes(i.to))
  const moreActive = more.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))

  // Trocar de tela, tocar fora ou apertar Esc fecha o menu.
  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <nav className="nav" aria-label="Principal">
      {primary.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end}>
          <Icon name={item.icon} />
          {item.label}
        </NavLink>
      ))}
      <div className="nav-more" ref={ref}>
        <button
          type="button"
          className={moreActive ? 'nav-more-btn active' : 'nav-more-btn'}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="more" />
          Mais
        </button>
        {open && (
          <div className="nav-more-menu" aria-label="Mais telas">
            {more.map((item) => (
              <NavLink key={item.to} to={item.to}>
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </nav>
  )
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
        <span className="subtle">Ctrl+` ou Esc fecha</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Fechar
        </Button>
      </header>
      <Console variant="panel" onClose={() => setOpen(false)} />
    </section>
  )
}

/** Atalho no topo que abre a paleta de comandos. */
function CommandBar({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="cmdbar" title="Ir para uma tela ou abrir o console" onClick={onOpen}>
      <Icon name="search" />
      <span>Executar comando…</span>
      <kbd>Ctrl K</kbd>
    </button>
  )
}

/** Paleta aberta por Ctrl+K: telas, console, tema e modo CLI. */
function Palette({ nav, onMode, mobile, onClose }: { nav: NavItem[]; onMode?: (mode: Mode) => void; mobile: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { setOpen } = useConsole()
  const { theme, setPreference } = useTheme()
  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = nav.map((n) => ({ id: n.to, label: n.label, hint: 'Ir para', icon: n.icon, run: () => navigate(n.to) }))
    if (!mobile) list.push({ id: 'console-panel', label: 'Abrir painel do console', hint: 'Ctrl+`', icon: 'console', run: () => setOpen(true) })
    list.push({
      id: 'theme',
      label: theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro',
      icon: theme === 'dark' ? 'sun' : 'moon',
      run: () => setPreference(theme === 'dark' ? 'light' : 'dark'),
    })
    if (onMode && !mobile) list.push({ id: 'cli', label: 'Mudar para o modo CLI', icon: 'console', run: () => onMode('cli') })
    return list
  }, [nav, navigate, setOpen, theme, setPreference, onMode, mobile])
  return <CommandPalette items={items} onClose={onClose} />
}

/** Alternância de tema na barra lateral (desktop), com rótulo. */
function ThemeRow() {
  const { theme, setPreference } = useTheme()
  const dark = theme === 'dark'
  return (
    <Button variant="ghost" onClick={() => setPreference(dark ? 'light' : 'dark')}>
      <Icon name={dark ? 'sun' : 'moon'} />
      {dark ? 'Tema claro' : 'Tema escuro'}
    </Button>
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
  const [palette, setPalette] = useState(false)
  const session = useSession()
  const nav = NAV.filter((item) => (!mobile || item.to !== '/console') && (!item.master || session.can('master')))

  // Ctrl+K abre a paleta (na página do console ele leva o foco à linha de comando).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && pathname !== '/console') {
        e.preventDefault()
        setPalette((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pathname])

  return (
    <ConsoleProvider onLogout={onLogout} mode="ui" onMode={onMode}>
      <div className="app">
        <aside className="side">
          <Brand />
          {mobile ? (
            <MobileNav items={nav} />
          ) : (
            <nav className="nav" aria-label="Principal">
              <span className="nav-label">Gerenciar</span>
              {nav.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <Icon name={item.icon} />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="side-foot">
            <ThemeRow />
            <Button variant="ghost" onClick={onLogout}>
              <Icon name="logout" />
              Sair
            </Button>
          </div>
        </aside>
        <div className="content">
          <header className="topnav">
            <Brand className="topnav-brand" />
            {!mobile && <CommandBar onOpen={() => setPalette(true)} />}
            <div className="topnav-right">
              {mobile && <ThemeToggle />}
              {onMode && !mobile && (
                <Button variant="ghost" size="sm" title="Usar só a linha de comando (a sessão continua)" onClick={() => onMode('cli')}>
                  <Icon name="console" />
                  Modo CLI
                </Button>
              )}
              {!mobile && session.username && session.role && (
                <span className="subtle" data-testid="whoami">
                  {session.username} · {ROLE_LABEL[session.role]}
                </span>
              )}
              {mobile && (
                <Button variant="ghost" size="sm" onClick={onLogout}>
                  Sair
                </Button>
              )}
            </div>
          </header>
          <main className="main">
            <Outlet />
          </main>
        </div>
      </div>
      {!mobile && <ConsolePanel />}
      {palette && <Palette nav={nav} onMode={onMode} mobile={mobile} onClose={() => setPalette(false)} />}
    </ConsoleProvider>
  )
}
