import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'

import { api } from '../api/client'
import { Button } from '../components/ui/Button'
import { Checkbox, Field, Input, Select } from '../components/ui/Field'
import { formatDateTime, shortId } from '../format'
import { type LogFilterState, LIMITS, SEVERITIES, toApiFilters } from './filters'
import { LogViewer, SEVERITY_LABEL } from './LogViewer'
import { useLogs } from './useLogs'

const TYPE_LABEL = { runtime: 'Execução (runtime)', build: 'Build' } as const

export interface LogsPanelProps {
  instanceId: string
  filters: LogFilterState
  onChange: (next: LogFilterState) => void
  /** Nome do arquivo baixado, sem extensão. */
  fileName: string
  /** Conteúdo à direita do título (links, botão de fechar). */
  actions?: ReactNode
  title?: ReactNode
}

/** Filtros, deploy, acompanhamento ao vivo e lista de logs de uma instância. */
export function LogsPanel({ instanceId, filters, onChange, fileName, actions, title }: LogsPanelProps) {
  const deployments = useQuery({
    queryKey: ['instance-deployments', instanceId],
    queryFn: () => api.instanceDeployments(instanceId),
  })
  const list = deployments.data?.deployments ?? []
  const currentId = list.find((d) => d.is_current)?.id
  const viewingOld = Boolean(filters.deployment) && filters.deployment !== currentId
  // Build, deploy antigo e intervalo fechado não têm o que acompanhar.
  const live = filters.type === 'runtime' && !viewingOld && !filters.end
  const logs = useLogs({ instanceId, filters: toApiFilters(filters), live })

  // O texto só vai ao Railway ao confirmar (Enter ou sair do campo), não a cada tecla.
  const [text, setText] = useState(filters.q)
  useEffect(() => setText(filters.q), [filters.q])
  const commitText = () => {
    if (text !== filters.q) onChange({ ...filters, q: text })
  }
  const set = (patch: Partial<LogFilterState>) => onChange({ ...filters, ...patch })

  function toggleSeverity(level: (typeof SEVERITIES)[number], on: boolean) {
    set({ severity: on ? [...filters.severity, level] : filters.severity.filter((s) => s !== level) })
  }

  const noDeployment = logs.deployment !== null && logs.deployment.id === null
  return (
    <section className="log-panel" aria-label="Logs">
      <div className="log-panel-head">
        <h2>{title ?? 'Logs'}</h2>
        <div className="row">{actions}</div>
      </div>

      <form
        className="log-filters"
        aria-label="Filtros de logs"
        onSubmit={(e) => {
          e.preventDefault()
          commitText()
        }}
      >
        <Field label="Tipo">
          {(p) => (
            <Select {...p} value={filters.type} onChange={(e) => set({ type: e.target.value as LogFilterState['type'], deployment: '' })}>
              {(Object.keys(TYPE_LABEL) as (keyof typeof TYPE_LABEL)[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Deploy">
          {(p) => (
            <Select {...p} value={filters.deployment} onChange={(e) => set({ deployment: e.target.value })}>
              <option value="">Atual (mais recente)</option>
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.status} · {d.created_at ? formatDateTime(d.created_at) : 'sem data'} · {shortId(d.id)}
                  {d.is_current ? ' (atual)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="De">
          {(p) => <Input {...p} type="datetime-local" value={filters.start} onChange={(e) => set({ start: e.target.value })} />}
        </Field>
        <Field label="Até" hint={filters.end ? 'Com limite final, não acompanha ao vivo.' : undefined}>
          {(p) => <Input {...p} type="datetime-local" value={filters.end} onChange={(e) => set({ end: e.target.value })} />}
        </Field>
        <Field label="Filtrar texto" hint="Enter aplica no Railway">
          {(p) => (
            <Input
              {...p}
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                // O formulário tem vários campos e nenhum botão de envio: o Enter é tratado aqui.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitText()
                }
              }}
              placeholder="Mensagem contém…"
            />
          )}
        </Field>
        <Field label="Linhas">
          {(p) => (
            <Select {...p} value={filters.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="log-severities">
          <legend>Severidade</legend>
          {SEVERITIES.map((level) => (
            <Checkbox
              key={level}
              label={SEVERITY_LABEL[level]}
              checked={filters.severity.includes(level)}
              onChange={(e) => toggleSeverity(level, e.target.checked)}
            />
          ))}
        </fieldset>
      </form>

      {logs.deployment && logs.deployment.id && !logs.deployment.isCurrent && (
        <div className="alert alert-info" role="status">
          <span className="alert-text">
            Você está vendo um deploy anterior ({logs.deployment.status ?? 'sem status'}), não o atual. Não é acompanhado ao vivo.
          </span>
        </div>
      )}

      <LogViewer
        lines={logs.lines}
        loading={logs.loading}
        error={logs.error}
        notice={logs.notice}
        truncated={logs.truncated}
        noDeployment={noDeployment}
        fileName={fileName}
        onRetry={logs.reload}
        toolbar={
          <>
            {live && (
              <Button size="sm" onClick={() => logs.setPaused(!logs.paused)} aria-pressed={logs.paused}>
                {logs.paused ? 'Retomar' : 'Pausar'}
              </Button>
            )}
            <Button size="sm" onClick={logs.reload} loading={logs.loading}>
              Atualizar
            </Button>
          </>
        }
      />
      {live && !logs.paused && !noDeployment && (
        <p className="subtle" role="status">
          Acompanhando ao vivo.
        </p>
      )}
      {live && logs.paused && (
        <p className="subtle" role="status">
          Acompanhamento pausado.
        </p>
      )}
    </section>
  )
}
