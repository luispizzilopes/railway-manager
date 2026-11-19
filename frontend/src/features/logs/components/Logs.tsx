import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'

import { api } from '@/shared/api/client'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Field, Select } from '@/shared/ui/Field/Field'
import { type LogFilterState, filtersToParams, paramsToFilters } from '@/features/logs/lib/filters'
import { LogsPanel } from './LogsPanel'

/** Escolha do serviço (projeto → ambiente → serviço) e logs dele, com o estado na URL. */
export function Logs() {
  const [params, setParams] = useSearchParams()
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })
  const instanceId = params.get('instance') ?? ''
  const filters = useMemo(() => paramsToFilters(params), [params])

  // Instâncias gerenciadas, achatadas com o contexto necessário para os seletores.
  const options = useMemo(
    () =>
      (dashboard.data?.projects ?? []).flatMap((p) =>
        p.environments.flatMap((e) =>
          e.instances.map((card) => ({
            id: card.id,
            service: card.service_name,
            projectId: p.project.id,
            projectName: p.project.display_name ?? p.project.name,
            environmentId: e.environment.id,
            environmentName: e.environment.name,
          })),
        ),
      ),
    [dashboard.data],
  )
  const found = options.find((o) => o.id === instanceId)
  const [projectId, setProjectId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  // Ao abrir por link (ou trocar de instância), os seletores seguem a instância da URL.
  useEffect(() => {
    if (found) {
      setProjectId(found.projectId)
      setEnvironmentId(found.environmentId)
    }
  }, [found])

  const projects = useMemo(
    () => [...new Map(options.map((o) => [o.projectId, o.projectName])).entries()],
    [options],
  )
  const environments = useMemo(
    () => [...new Map(options.filter((o) => o.projectId === projectId).map((o) => [o.environmentId, o.environmentName])).entries()],
    [options, projectId],
  )
  const services = options.filter((o) => o.projectId === projectId && o.environmentId === environmentId)

  function chooseInstance(id: string) {
    const next = new URLSearchParams(params)
    if (id) next.set('instance', id)
    else next.delete('instance')
    setParams(next, { replace: true })
  }

  function changeFilters(state: LogFilterState) {
    setParams(
      (prev) => {
        const next = filtersToParams(state, new URLSearchParams(prev))
        if (instanceId) next.set('instance', instanceId)
        return next
      },
      { replace: true },
    )
  }

  if (dashboard.error) return <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
  if (!dashboard.data) return <Skeleton lines={4} label="Carregando serviços…" />

  const missing = Boolean(instanceId) && !found

  return (
    <div className="log-page">
      <div className="page-head">
        <div>
          <h1>Logs</h1>
          <p className="muted">Escolha um serviço para ver os logs de execução e de build.</p>
        </div>
      </div>

      {options.length === 0 ? (
        <EmptyState title="Nenhum serviço gerenciado">Importe serviços em um projeto para ver os logs deles aqui.</EmptyState>
      ) : (
        <div className="card card-body" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="form-grid">
            <Field label="Projeto">
              {(p) => (
                <Select
                  {...p}
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value)
                    setEnvironmentId('')
                    chooseInstance('')
                  }}
                >
                  <option value="">Escolha…</option>
                  {projects.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Ambiente">
              {(p) => (
                <Select
                  {...p}
                  value={environmentId}
                  disabled={!projectId}
                  onChange={(e) => {
                    setEnvironmentId(e.target.value)
                    chooseInstance('')
                  }}
                >
                  <option value="">Escolha…</option>
                  {environments.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Serviço">
              {(p) => (
                <Select {...p} value={found ? instanceId : ''} disabled={!environmentId} onChange={(e) => chooseInstance(e.target.value)}>
                  <option value="">Escolha…</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.service}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </div>
      )}

      {missing ? (
        <EmptyState title="Serviço não encontrado">Este serviço não está mais gerenciado. Escolha outro acima.</EmptyState>
      ) : found ? (
        <LogsPanel
          // A troca de serviço recomeça o estado interno do painel.
          key={found.id}
          instanceId={found.id}
          filters={filters}
          onChange={changeFilters}
          fileName={`${found.projectName}-${found.service}-${found.environmentName}`}
          title={`${found.service} · ${found.environmentName}`}
        />
      ) : options.length > 0 ? (
        <EmptyState title="Escolha um serviço">Selecione o projeto, o ambiente e o serviço para ver os logs.</EmptyState>
      ) : null}
    </div>
  )
}
