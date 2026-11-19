import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { Brand } from '@/shared/components/Brand/Brand'
import { CommandPalette, type PaletteItem } from '@/shared/components/CommandPalette/CommandPalette'
import { Icon, type IconName } from '@/shared/components/Icon/Icon'
import { ThemeToggle } from '@/shared/components/ThemeToggle/ThemeToggle'
import { Button } from '@/shared/ui/Button/Button'
import { Console } from '@/features/console/components/Console'
import { ConsoleProvider, useConsole } from '@/features/console/context/ConsoleProvider'
import type { Mode } from '@/features/auth/lib/mode'
import { roleLabel, useSession } from '@/features/auth/lib/session'
import { useTheme } from '@/shared/lib/theme'

/** Chave do rótulo em `nav.*` no catálogo. */
type NavKey = 'overview' | 'projects' | 'schedules' | 'history' | 'logs' | 'console' | 'users' | 'settings'
type NavItem = { to: string; label: NavKey; icon: IconName; end?: boolean; master?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'overview', icon: 'overview', end: true },
  { to: '/projects', label: 'projects', icon: 'projects' },
  { to: '/schedules', label: 'schedules', icon: 'schedules' },
  { to: '/history', label: 'history', icon: 'history' },
  { to: '/logs', label: 'logs', icon: 'logs' },
  { to: '/console', label: 'console', icon: 'console' },
  { to: '/users', label: 'users', icon: 'users', master: true },
  { to: '/settings', label: 'settings', icon: 'settings' },
]

/** Telas que ficam na barra do celular; as demais vão para o menu "Mais". */
const MOBILE_PRIMARY = ['/', '/projects', '/schedules', '/history']

/** Navegação do celular: abas principais e um menu "Mais" com o restante. */
function MobileNav({ items }: { items: NavItem[] }) {
  const { t } = useTranslation()
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
    <nav className="nav" aria-label={t('nav.main')}>
      {primary.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end}>
          <Icon name={item.icon} />
          {t(`nav.${item.label}`)}
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
          {t('nav.more')}
        </button>
        {open && (
          <div className="nav-more-menu" aria-label={t('nav.moreScreens')}>
            {more.map((item) => (
              <NavLink key={item.to} to={item.to}>
                <Icon name={item.icon} />
                {t(`nav.${item.label}`)}
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
  const { t } = useTranslation()
  const { open, setOpen } = useConsole()
  const { pathname } = useLocation()
  if (!open || pathname === '/console') return null
  return (
    <section className="console-drawer" aria-label={t('nav.console')}>
      <header className="console-drawer-head">
        <strong>{t('nav.console')}</strong>
        <span className="subtle">{t('layout.consoleCloseHint')}</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t('ui.close')}
        </Button>
      </header>
      <Console variant="panel" onClose={() => setOpen(false)} />
    </section>
  )
}

/** Atalho no topo que abre a paleta de comandos. */
function CommandBar({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" className="cmdbar" title={t('layout.commandBarTitle')} onClick={onOpen}>
      <Icon name="search" />
      <span>{t('layout.commandBar')}</span>
      <kbd>Ctrl K</kbd>
    </button>
  )
}

/** Paleta aberta por Ctrl+K: telas, console, tema e modo CLI. */
function Palette({ nav, onMode, mobile, onClose }: { nav: NavItem[]; onMode?: (mode: Mode) => void; mobile: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { setOpen } = useConsole()
  const { theme, setPreference } = useTheme()
  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = nav.map((n) => ({ id: n.to, label: t(`nav.${n.label}`), hint: t('layout.goTo'), icon: n.icon, run: () => navigate(n.to) }))
    if (!mobile) list.push({ id: 'console-panel', label: t('layout.openConsolePanel'), hint: 'Ctrl+`', icon: 'console', run: () => setOpen(true) })
    list.push({
      id: 'theme',
      label: theme === 'dark' ? t('theme.useLight') : t('theme.useDark'),
      icon: theme === 'dark' ? 'sun' : 'moon',
      run: () => setPreference(theme === 'dark' ? 'light' : 'dark'),
    })
    if (onMode && !mobile) list.push({ id: 'cli', label: t('layout.switchToCli'), icon: 'console', run: () => onMode('cli') })
    return list
  }, [t, nav, navigate, setOpen, theme, setPreference, onMode, mobile])
  return <CommandPalette items={items} onClose={onClose} />
}

/** Alternância de tema na barra lateral (desktop), com rótulo. */
function ThemeRow() {
  const { t } = useTranslation()
  const { theme, setPreference } = useTheme()
  const dark = theme === 'dark'
  return (
    <Button variant="ghost" onClick={() => setPreference(dark ? 'light' : 'dark')}>
      <Icon name={dark ? 'sun' : 'moon'} />
      {dark ? t('theme.light') : t('theme.dark')}
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
  const { t } = useTranslation()
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
            <nav className="nav" aria-label={t('nav.main')}>
              <span className="nav-label">{t('nav.manage')}</span>
              {nav.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <Icon name={item.icon} />
                  {t(`nav.${item.label}`)}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="side-foot">
            <ThemeRow />
            <Button variant="ghost" onClick={onLogout}>
              <Icon name="logout" />
              {t('layout.logout')}
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
                <Button variant="ghost" size="sm" title={t('layout.cliModeTitle')} onClick={() => onMode('cli')}>
                  <Icon name="console" />
                  {t('layout.cliMode')}
                </Button>
              )}
              {!mobile && session.username && session.role && (
                <span className="subtle" data-testid="whoami">
                  {session.username} · {roleLabel(session.role)}
                </span>
              )}
              {mobile && (
                <Button variant="ghost" size="sm" onClick={onLogout}>
                  {t('layout.logout')}
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
