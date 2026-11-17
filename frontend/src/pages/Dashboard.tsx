import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

import { api } from '../api/client'
import type { Dashboard as DashboardData, InstanceCard, PowerKind, PowerTarget } from '../api/types'
import { ErrorAlert } from '../components/Modal'
import { OperationFlow } from '../components/OperationFlow'
import { FreshnessNote, StateChip } from '../components/StateChip'
import { KIND_LABEL, STATUS_LABEL, formatTime, relativeTime } from '../format'

/** Intervalo da atualização automática enquanto a tela está aberta. */
export const AUTO_REFRESH_MS = 60_000

type Flow = { kind: PowerKind; target: PowerTarget; title: string; confirm: boolean }

function Indicators({ data }: { data: DashboardData }) {
  const i = data.indicators
  const stats = [
    { label: 'Projetos', value: i.projects },
    { label: 'Serviços monitorados', value: i.instances },
    { label: 'Ativos', value: i.running, note: i.sleeping ? `${i.sleeping} dormindo` : undefined },
    { label: 'Desligados', value: i.stopped },
    { label: 'Com falha', value: i.failed },
    { label: 'Outros estados', value: i.other },
  ]
  return (
    <div className="stats">
      {stats.map((s) => (
        <div className="card stat" key={s.label} data-testid={`stat-${s.label}`}>
          <div className="stat-value">{s.value}</div>
          <div className="stat-label">{s.label}</div>
          {s.note && <div className="stat-note">{s.note}</div>}
        </div>
      ))}
    </div>
  )
}

export function InstanceRow({
  card,
  disabled,
  onAction,
}: {
  card: InstanceCard
  disabled: boolean
  onAction: (kind: PowerKind) => void
}) {
  const off = card.state === 'stopped' || card.state === 'failed'
  return (
    <div className="instance-row" data-testid="instance-row" data-freshness={card.freshness}>
      <span className="instance-name">{card.service_name}</span>
      <StateChip state={card.state} freshness={card.freshness} />
      <span>
        {card.not_found ? (
          <span className="freshness freshness-unavailable">Não encontrado no Railway</span>
        ) : (
          <FreshnessNote freshness={card.freshness} observedAt={card.last_observed_at} error={card.last_sync_error} />
        )}
      </span>
      <span className="row">
        {card.busy ? (
          <span className="subtle">operação em andamento</span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || card.not_found}
            onClick={() => onAction(off ? 'start' : 'stop')}
          >
            {off ? 'Iniciar' : 'Desligar'}
          </button>
        )}
      </span>
    </div>
  )
}

export function Dashboard() {
  const queryClient = useQueryClient()
  const [flow, setFlow] = useState<Flow | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    refetchInterval: AUTO_REFRESH_MS,
  })
  // Atualização automática relê o Railway, respeitando o rate limit: pausa quando esgotado.
  const paused = Boolean(dashboard.data?.rate_limit.paused_until)
  const ready = dashboard.data?.integration_ready ?? false
  useQuery({
    queryKey: ['auto-refresh'],
    queryFn: async () => {
      await api.refresh()
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      return Date.now()
    },
    enabled: ready && !paused,
    refetchInterval: AUTO_REFRESH_MS,
    refetchOnWindowFocus: false,
  })
  const refresh = useMutation({
    mutationFn: api.refresh,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })

  const data = dashboard.data
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Visão geral</h1>
          <p className="muted">
            {data ? `Atualizado ${relativeTime(data.generated_at)}` : 'Carregando…'}
            {data?.rate_limit.remaining != null && data.rate_limit.limit != null && (
              <span className="subtle">
                {' '}
                · cota do Railway: {data.rate_limit.remaining}/{data.rate_limit.limit}
              </span>
            )}
          </p>
        </div>
        <div className="row">
          {selected.length > 0 && (
            <>
              <span className="subtle">{selected.length} projeto(s) selecionado(s)</span>
              {(['start', 'stop'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="btn"
                  disabled={!ready}
                  onClick={() =>
                    setFlow({
                      kind,
                      target: { type: 'batch', project_ids: selected },
                      title: `${KIND_LABEL[kind]} projetos selecionados`,
                      confirm: true,
                    })
                  }
                >
                  {KIND_LABEL[kind]} selecionados
                </button>
              ))}
            </>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !ready}
          >
            {refresh.isPending ? 'Atualizando…' : 'Atualizar estados'}
          </button>
        </div>
      </div>

      <div className="stack">
        <ErrorAlert error={dashboard.error ?? refresh.error} />
        {data?.alerts.map((a) => (
          <div key={a.code + a.message} className={a.code === 'rate_limited' ? 'alert alert-warn' : 'alert alert-danger'} role="alert">
            <span>
              {a.message}{' '}
              {(a.code === 'no_credential' || a.code.startsWith('credential')) && <Link to="/settings">Configurar token</Link>}
            </span>
          </div>
        ))}

        {data && <Indicators data={data} />}
      </div>

      {data && data.projects.length === 0 && (
        <div className="card empty">
          <h3>Nenhum projeto gerenciado</h3>
          <p>
            <Link to="/projects">Importe projetos</Link> da sua conta do Railway para começar.
          </p>
        </div>
      )}

      {data?.projects.map(({ project, environments, next_action }) => (
        <section key={project.id} className="card project-card" aria-label={project.display_name ?? project.name}>
          <div className="card-head">
            <input
              type="checkbox"
              aria-label={`Selecionar ${project.display_name ?? project.name}`}
              checked={selected.includes(project.id)}
              onChange={() => toggle(project.id)}
            />
            <h3>
              <Link to={`/projects/${project.id}`}>{project.display_name ?? project.name}</Link>
            </h3>
            {project.sync_status === 'not_found' && <span className="result result-failed">não encontrado no Railway</span>}
            {next_action && (
              <span className="next-action" data-testid="next-action">
                Próxima: {KIND_LABEL[next_action.action]} às {formatTime(next_action.at)} ·{' '}
                <Link to="/schedules">{next_action.schedule_name}</Link>
              </span>
            )}
            <span className="spacer" />
            {(['start', 'stop'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn btn-sm"
                disabled={!ready || environments.length === 0}
                onClick={() =>
                  setFlow({
                    kind,
                    target: { type: 'project', project_id: project.id },
                    title: `${KIND_LABEL[kind]} todos — ${project.display_name ?? project.name}`,
                    confirm: true,
                  })
                }
              >
                {kind === 'start' ? 'Iniciar todos' : 'Desligar todos'}
              </button>
            ))}
          </div>
          {environments.length === 0 && (
            <div className="card-body muted">
              Nenhuma instância gerenciada. <Link to={`/projects/${project.id}`}>Importar instâncias</Link>
            </div>
          )}
          {environments.map(({ environment, instances }) => (
            <div key={environment.id} className="env-group">
              <div className="env-label">{environment.name}</div>
              {instances.map((card) => (
                <InstanceRow
                  key={card.id}
                  card={card}
                  disabled={!ready}
                  onAction={(kind) =>
                    setFlow({
                      kind,
                      target: { type: 'instance', instance_id: card.id },
                      title: `${KIND_LABEL[kind]} ${card.service_name} (${environment.name})`,
                      confirm: false,
                    })
                  }
                />
              ))}
            </div>
          ))}
        </section>
      ))}

      {data && data.recent_operations.length > 0 && (
        <section className="card" style={{ marginTop: 'var(--space-5)' }}>
          <div className="card-head">
            <h3>Últimas operações</h3>
            <span className="spacer" />
            <Link to="/history">Ver histórico</Link>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Tipo</th>
                  <th>Projetos</th>
                  <th>Resultado</th>
                  <th className="num">Itens</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_operations.map((s) => (
                  <tr key={s.operation.id}>
                    <td>{relativeTime(s.operation.created_at)}</td>
                    <td>{KIND_LABEL[s.operation.kind]}</td>
                    <td>{s.projects.join(', ')}</td>
                    <td>
                      <span className={`result result-${s.operation.status}`}>{STATUS_LABEL[s.operation.status]}</span>
                    </td>
                    <td className="num">
                      {s.succeeded}✓ {s.failed > 0 && `${s.failed}✗ `}
                      {s.skipped > 0 && `${s.skipped} ignorado(s)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {flow && <OperationFlow {...flow} onClose={() => setFlow(null)} />}
    </>
  )
}
