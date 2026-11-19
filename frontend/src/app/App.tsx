import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes } from 'react-router'

import { UNAUTHORIZED_EVENT, api } from '@/shared/api/client'
import { type Mode, readMode, writeMode } from '@/features/auth/lib/mode'
import { useIsMobile } from '@/shared/lib/mobile'
import { CliApp } from '@/features/console/components/CliApp'
import { ConsolePage } from '@/features/console/components/ConsolePage'
import { Dashboard } from '@/features/dashboard/components/Dashboard'
import { History } from '@/features/history/components/History'
import { Layout } from '@/app/layout/Layout'
import { Login } from '@/features/auth/components/Login'
import { Logs } from '@/features/logs/components/Logs'
import { ModeChooser } from '@/features/auth/components/ModeChooser'
import { ProjectDetail } from '@/features/projects/components/ProjectDetail'
import { Projects } from '@/features/projects/components/Projects'
import { Schedules } from '@/features/schedules/components/Schedules'
import { Settings } from '@/features/settings/components/Settings'
import { Users } from '@/features/users/components/Users'

export function App() {
  // Assina o idioma: trocar de idioma re-renderiza a árvore inteira sem remontá-la.
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false, staleTime: Infinity })
  const mobile = useIsMobile()
  const [storedMode, setModeState] = useState<Mode | null>(readMode)
  // No celular só existe a interface gráfica, sem escolha de modo.
  const mode: Mode | null = mobile ? 'ui' : storedMode

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

  if (session.isPending) return null
  const authenticated = Boolean(session.data)
  // A escolha vem antes do login; com sessão e sem escolha, vale a interface gráfica.
  if (!authenticated && mode === null) return <ModeChooser onChoose={setMode} />
  if (mode === 'cli') {
    return <CliApp authenticated={authenticated} onLogin={afterLogin} onLogout={logout} onMode={setMode} />
  }
  if (!authenticated) return <Login onLogin={() => void afterLogin()} onCli={mobile ? undefined : () => setMode('cli')} />

  return (
    <Routes>
      <Route element={<Layout onLogout={logout} onMode={mobile ? undefined : setMode} mobile={mobile} />}>
        <Route index element={<Dashboard />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="logs" element={<Logs />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="history" element={<History />} />
        <Route path="console" element={mobile ? <Navigate to="/" replace /> : <ConsolePage />} />
        <Route path="users" element={<Users />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<p className="muted">{t('layout.notFound')}</p>} />
      </Route>
    </Routes>
  )
}
