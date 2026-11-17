import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Route, Routes } from 'react-router'

import { UNAUTHORIZED_EVENT, api } from './api/client'
import { ConsolePage } from './pages/ConsolePage'
import { Dashboard } from './pages/Dashboard'
import { History } from './pages/History'
import { Layout } from './pages/Layout'
import { Login } from './pages/Login'
import { ProjectDetail } from './pages/ProjectDetail'
import { Projects } from './pages/Projects'
import { Schedules } from './pages/Schedules'
import { Settings } from './pages/Settings'

export function App() {
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false, staleTime: Infinity })

  useEffect(() => {
    const expired = () => queryClient.setQueryData(['session'], null)
    window.addEventListener(UNAUTHORIZED_EVENT, expired)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, expired)
  }, [queryClient])

  if (session.isPending) return null
  if (!session.data) {
    return (
      <Login
        onLogin={() => {
          // Descarta dados de outra sessão, mas mantém a consulta de sessão para relê-la.
          queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
          void queryClient.refetchQueries({ queryKey: ['session'] })
        }}
      />
    )
  }

  async function logout() {
    await api.logout().catch(() => undefined)
    // `clear()` removeria a consulta observada pelo App e a tela não mudaria.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    queryClient.setQueryData(['session'], null)
  }

  return (
    <Routes>
      <Route element={<Layout onLogout={logout} />}>
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
