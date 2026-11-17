import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Route, Routes } from 'react-router'

import { UNAUTHORIZED_EVENT, api } from './api/client'
import { type Mode, readMode, writeMode } from './mode'
import { CliApp } from './pages/CliApp'
import { ConsolePage } from './pages/ConsolePage'
import { Dashboard } from './pages/Dashboard'
import { History } from './pages/History'
import { Layout } from './pages/Layout'
import { Login } from './pages/Login'
import { ModeChooser } from './pages/ModeChooser'
import { MobileNotice, isMobileDevice } from './pages/MobileNotice'
import { ProjectDetail } from './pages/ProjectDetail'
import { Projects } from './pages/Projects'
import { Schedules } from './pages/Schedules'
import { Settings } from './pages/Settings'

export function App() {
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false, staleTime: Infinity })
  const [mode, setModeState] = useState<Mode | null>(readMode)

  useEffect(() => {
    const expired = () => queryClient.setQueryData(['session'], null)
    window.addEventListener(UNAUTHORIZED_EVENT, expired)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, expired)
  }, [queryClient])

  function setMode(next: Mode) {
    writeMode(next)
    setModeState(next)
  }

  async function afterLogin() {
    // Descarta dados de outra sessão, mas mantém a consulta de sessão para relê-la.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    await queryClient.refetchQueries({ queryKey: ['session'] })
  }

  async function logout() {
    await api.logout().catch(() => undefined)
    // `clear()` removeria a consulta observada pelo App e a tela não mudaria.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    queryClient.setQueryData(['session'], null)
  }

  if (isMobileDevice()) return <MobileNotice />
  if (session.isPending) return null
  const authenticated = Boolean(session.data)
  // A escolha vem antes do login; com sessão e sem escolha, vale a interface gráfica.
  if (!authenticated && mode === null) return <ModeChooser onChoose={setMode} />
  if (mode === 'cli') {
    return <CliApp authenticated={authenticated} onLogin={afterLogin} onLogout={logout} onMode={setMode} />
  }
  if (!authenticated) return <Login onLogin={() => void afterLogin()} onCli={() => setMode('cli')} />

  return (
    <Routes>
      <Route element={<Layout onLogout={logout} onMode={setMode} />}>
        <Route index element={<Dashboard />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="history" element={<History />} />
        <Route path="console" element={<ConsolePage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<p className="muted">Página não encontrada.</p>} />
      </Route>
    </Routes>
  )
}
