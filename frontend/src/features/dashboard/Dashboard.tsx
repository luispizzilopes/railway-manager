import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { api } from '@/shared/api/client'
import type { Dashboard as DashboardData, InstanceCard, ObservedState, PowerKind, PowerTarget } from '@/shared/api/types'
import { Icon } from '@/shared/components/Icon'
import { OperationFlow } from '@/shared/components/OperationFlow'
import { FreshnessNote } from '@/shared/components/StateChip'
import { Button } from '@/shared/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback'
import { Input, Select } from '@/shared/ui/Field'
import { StatusBadge } from '@/shared/ui/StatusBadge'
import { Table } from '@/shared/ui/Table'
import { useFeedbackMutation } from '@/shared/components/useFeedbackMutation'
import { KIND_LABEL, STATE_LABEL, STATUS_LABEL, formatTime, relativeTime } from '@/shared/lib/format'
import { useSession } from '../auth/session'

/** Intervalo da atualização automática enquanto a tela está aberta. */
export const AUTO_REFRESH_MS = 60_000

type Flow = { kind: PowerKind; target: PowerTarget; title: string; confirm: boolean }
type Segment = { state: ObservedState; count: number }
type Project = DashboardData['projects'][number]

const SEGMENT_ORDER: ObservedState[] = ['running', 'sleeping', 'transitioning', 'awaiting_approval', 'stopped', 'failed', 'unknown']

/** Barra segmentada com a proporção de serviços em cada estado. */
function StateBar({ segments, className = '' }: { segments: Segment[]; className?: string }) {
  const total = segments.reduce((n, s) => n + s.count, 0)
  return (
    <div className={`statebar ${className}`} role="img" aria-label={segments.map((s) => `${s.count} ${STATE_LABEL[s.state]}`).join(', ')}>
      {total === 0 ? (
        <span className="statebar-seg statebar-empty" style={{ flexGrow: 1 }} />
      ) : (
        segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span key={s.state} className={`statebar-seg seg-${s.state}`} style={{ flexGrow: s.count }} title={`${STATE_LABEL[s.state]}: ${s.count}`} />
          ))
      )}
    </div>
  )
}

function countStates(cards: InstanceCard[]): Segment[] {
  return SEGMENT_ORDER.map((state) => ({ state, count: cards.filter((c) => c.state === state).length }))
}

/** Resumo de saúde: frase curta, proporção por estado e as contagens do painel. */
function Summary({ data }: { data: DashboardData }) {
  const i = data.indicators
  const segments: Segment[] = [
    { state: 'running', count: i.running - i.sleeping },
    { state: 'sleeping', count: i.sleeping },
    { state: 'stopped', count: i.stopped },
    { state: 'failed', count: i.failed },
    { state: 'unknown', count: i.other },
  ]
  const pct = i.instances > 0 ? Math.round((i.running / i.instances) * 100) : null
  const headline =
    i.instances === 0
      ? 'Nenhum serviço monitorado'
      : i.failed > 0
        ? `${i.failed} ${i.failed === 1 ? 'serviço com falha' : 'serviços com falha'}`
        : `${i.running} de ${i.instances} serviços em operação`
  const stats = [
    { label: 'Projetos', value: i.projects },
    { label: 'Serviços monitorados', value: i.instances },
    { label: 'Ativos', value: i.running, note: i.sleeping ? `${i.sleeping} dormindo` : undefined, tone: 'running' },
    { label: 'Desligados', value: i.stopped },
    { label: 'Com falha', value: i.failed, tone: i.failed > 0 ? 'alert' : undefined },
    { label: 'Outros estados', value: i.other },
  ]
  return (
    <section className="card" aria-label="Resumo" data-testid="health-panel">
      <div className="summary">
        <div className="summary-top">
          <span className="summary-headline">{headline}</span>
          {pct !== null && (
            <span className="summary-pct" title="Serviços ativos ou dormindo">
              <span className="mono">{pct}%</span> em operação
            </span>
          )}
        </div>
        <StateBar segments={segments} />
        <ul className="legend">
          {segments.filter((s) => s.count > 0 || s.state !== 'unknown').map((s) => (
            <li key={s.state}>
              <span className={`dot dot-${s.state}`} />
              <span className="legend-label">{STATE_LABEL[s.state]}</span>
              <span className="legend-count">{s.count}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="stats">
        {stats.map((s) => (
          <div className={`stat${s.tone ? ` stat-${s.tone}` : ''}`} key={s.label} data-testid={`stat-${s.label}`}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            {s.note && <div className="stat-note">{s.note}</div>}
          </div>
        ))}
      </div>
    </section>
  )
}

type Attention = { card: InstanceCard; project: Project['project']; environment: string; reason: string }

/** Serviços que exigem atenção, com o motivo em texto. */
function attentionItems(projects: Project[]): Attention[] {
  const items: Attention[] = []
  for (const { project, environments } of projects) {
    for (const { environment, instances } of environments) {
      for (const card of instances) {
        const reason = card.not_found
          ? 'Não encontrado no Railway'
          : card.state === 'failed'
            ? 'Com falha'
            : card.state === 'awaiting_approval'
              ? 'Aguardando aprovação'
              : card.freshness === 'unavailable'
                ? 'Leitura indisponível'
                : card.freshness === 'stale'
                  ? 'Leitura desatualizada'
                  : null
        if (reason) items.push({ card, project, environment: environment.name, reason })
      }
    }
  }
  return items
}

function AttentionPanel({
  items,
  ready,
  canOperate,
  onStart,
}: {
  items: Attention[]
  ready: boolean
  canOperate: boolean
  onStart: (a: Attention) => void
}) {
  if (items.length === 0) {
    return (
      <p className="all-clear">
        <Icon name="check" />
        Nenhum serviço requer atenção.
      </p>
    )
  }
  return (
    <section className="card attention" aria-label="Requer atenção">
      <div className="card-head">
        <h3>Requer atenção</h3>
        <span className="subtle">{items.length}</span>
      </div>
      {items.map((a) => (
        <div className="attention-item" key={a.card.id}>
          <StatusBadge state={a.card.state} freshness={a.card.freshness} />
          <span className="attention-name">{a.card.service_name}</span>
          <span className="subtle">
            {a.project.display_name ?? a.project.name} · {a.environment} · {a.reason}
          </span>
          <span className="spacer" />
          {canOperate && a.card.state === 'failed' && !a.card.not_found && !a.card.busy ? (
            <Button size="sm" disabled={!ready} onClick={() => onStart(a)}>
              Iniciar
            </Button>
          ) : (
            <Link to={`/projects/${a.project.id}`}>Ver projeto</Link>
          )}
        </div>
      ))}
    </section>
  )
}

export function InstanceRow({
  card,
  disabled,
  readOnly = false,
  onAction,
}: {
  card: InstanceCard
  disabled: boolean
  /** Papel sem permissão de operar: some o botão de ligar/desligar. */
  readOnly?: boolean
  onAction: (kind: PowerKind) => void
}) {
  const off = card.state === 'stopped' || card.state === 'failed'
  return (
    <tr className={`instance-row row-${card.state}`} data-testid="instance-row" data-freshness={card.freshness}>
      <td>
        <span className="instance-name">{card.service_name}</span>
      </td>
      <td>
        <StatusBadge state={card.state} freshness={card.freshness} />
      </td>
      <td>
        {card.not_found ? (
          <span className="freshness freshness-unavailable">Não encontrado no Railway</span>
        ) : (
          <FreshnessNote freshness={card.freshness} observedAt={card.last_observed_at} error={card.last_sync_error} />
        )}
      </td>
      <td className="actions">
        {card.busy ? (
          <span className="subtle">operação em andamento</span>
        ) : readOnly ? null : (
          <Button size="sm" disabled={disabled || card.not_found} onClick={() => onAction(off ? 'start' : 'stop')}>
            {off ? 'Iniciar' : 'Desligar'}
          </Button>
        )}
      </td>
    </tr>
  )
}

function ProjectSummary({ cards }: { cards: InstanceCard[] }) {
  const running = cards.filter((c) => c.state === 'running' || c.state === 'sleeping').length
  return (
    <span className="project-summary" title={`${running} de ${cards.length} em operação`}>
      <StateBar segments={countStates(cards)} className="statebar-sm" />
      <span className="mono">
        {running}/{cards.length}
      </span>
    </span>
  )
}

const STATE_FILTERS: ObservedState[] = ['running', 'sleeping', 'stopped', 'transitioning', 'failed', 'awaiting_approval', 'unknown']

export function Dashboard() {
  const queryClient = useQueryClient()
  const canOperate = useSession().can('operator')
  const [flow, setFlow] = useState<Flow | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const stateFilter = params.get('estado') ?? ''
  const projectFilter = params.get('projeto') ?? ''
  const envFilter = params.get('ambiente') ?? ''
  const filtering = Boolean(query || stateFilter || projectFilter || envFilter)

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
    enabled: ready && !paused && canOperate,
    refetchInterval: AUTO_REFRESH_MS,
    refetchOnWindowFocus: false,
  })
  const refresh = useFeedbackMutation({
    mutationFn: api.refresh,
    success: 'Estados atualizados.',
    invalidate: [['dashboard']],
  })

  const data = dashboard.data
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  function setFilter(key: string, value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }

  const attention = useMemo(() => (data ? attentionItems(data.projects) : []), [data])

  // Filtros: mantém só projetos, ambientes e serviços que correspondem.
  const visible = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.projects
      .filter(({ project }) => !projectFilter || project.id === projectFilter)
      .map((p) => ({
        ...p,
        environments: p.environments
          .filter(({ environment }) => !envFilter || environment.name === envFilter)
          .map((e) => ({
            ...e,
            instances: e.instances.filter(
              (c) => (!q || c.service_name.toLowerCase().includes(q)) && (!stateFilter || c.state === stateFilter),
            ),
          }))
          .filter((e) => !filtering || e.instances.length > 0),
      }))
      .filter((p) => !filtering || p.environments.length > 0)
  }, [data, query, stateFilter, projectFilter, envFilter, filtering])

  const matches = visible.reduce((n, p) => n + p.environments.reduce((m, e) => m + e.instances.length, 0), 0)
  const environmentNames = useMemo(
    () => [...new Set((data?.projects ?? []).flatMap((p) => p.environments.map((e) => e.environment.name)))],
    [data],
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Visão geral</h1>
          <p className="muted">
            {data ? (
              <span className={`live${paused ? ' live-paused' : ''}`}>
                <span className="live-dot" aria-hidden="true" />
                {paused ? 'Atualização pausada (cota do Railway)' : 'Atualização automática'} · atualizado {relativeTime(data.generated_at)}
              </span>
            ) : (
              'Carregando…'
            )}
            {data?.rate_limit.remaining != null && data.rate_limit.limit != null && (
              <span className="subtle">
                {' '}
                · cota do Railway: {data.rate_limit.remaining}/{data.rate_limit.limit}
              </span>
            )}
          </p>
        </div>
        <div className="row">
          {canOperate && selected.length > 0 && (
            <>
              <span className="subtle">{selected.length} projeto(s) selecionado(s)</span>
              {(['start', 'stop'] as const).map((kind) => (
                <Button
                  key={kind}
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
                </Button>
              ))}
            </>
          )}
          {canOperate && (
            <Button variant="primary" onClick={() => refresh.mutate()} loading={refresh.isPending} disabled={!ready}>
              Atualizar estados
            </Button>
          )}
        </div>
      </div>

      <div className="stack">
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} retrying={dashboard.isFetching} />
        {data?.alerts.map((a) => (
          <div key={a.code + a.message} className={a.code === 'rate_limited' ? 'alert alert-warn' : 'alert alert-danger'} role="alert">
            <span>
              {a.message}{' '}
              {(a.code === 'no_credential' || a.code.startsWith('credential')) && <Link to="/settings">Configurar token</Link>}
            </span>
          </div>
        ))}

        {dashboard.isPending && (
          <div className="card">
            <Skeleton lines={5} label="Carregando a visão geral…" />
          </div>
        )}

        {data && (
          <>
            <AttentionPanel
              items={attention}
              ready={ready}
              canOperate={canOperate}
              onStart={({ card, project, environment }) =>
                setFlow({
                  kind: 'start',
                  target: { type: 'instance', instance_id: card.id },
                  title: `Iniciar ${card.service_name} (${environment}) — ${project.display_name ?? project.name}`,
                  confirm: false,
                })
              }
            />
            <Summary data={data} />
          </>
        )}
      </div>

      {data && data.projects.length === 0 && (
        <div className="card" style={{ marginTop: 'var(--space-4)' }}>
          <EmptyState
            title="Nenhum projeto gerenciado"
            action={
              <Link to="/projects" className="btn btn-primary">
                Importar projetos
              </Link>
            }
          >
            Importe projetos da sua conta do Railway para começar.
          </EmptyState>
        </div>
      )}

      {data && data.projects.length > 0 && (
        <div className="toolbar" role="search" style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>
          <Input
            type="search"
            aria-label="Buscar serviço"
            placeholder="Buscar serviço…"
            value={query}
            onChange={(e) => setFilter('q', e.target.value)}
          />
          <Select aria-label="Filtrar por estado" value={stateFilter} onChange={(e) => setFilter('estado', e.target.value)}>
            <option value="">Todos os estados</option>
            {STATE_FILTERS.map((st) => (
              <option key={st} value={st}>
                {STATE_LABEL[st]}
              </option>
            ))}
          </Select>
          <Select aria-label="Filtrar por projeto" value={projectFilter} onChange={(e) => setFilter('projeto', e.target.value)}>
            <option value="">Todos os projetos</option>
            {data.projects.map(({ project }) => (
              <option key={project.id} value={project.id}>
                {project.display_name ?? project.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Filtrar por ambiente" value={envFilter} onChange={(e) => setFilter('ambiente', e.target.value)}>
            <option value="">Todos os ambientes</option>
            {environmentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          {filtering && (
            <Button variant="ghost" onClick={() => setParams({}, { replace: true })}>
              Limpar filtros
            </Button>
          )}
          <span className="toolbar-count" aria-live="polite">
            {filtering ? `${matches} ${matches === 1 ? 'serviço encontrado' : 'serviços encontrados'}` : `${matches} ${matches === 1 ? 'serviço' : 'serviços'}`}
          </span>
        </div>
      )}

      {data && data.projects.length > 0 && filtering && visible.length === 0 && (
        <div className="card">
          <EmptyState
            title="Nenhum serviço encontrado"
            action={<Button onClick={() => setParams({}, { replace: true })}>Limpar filtros</Button>}
          >
            Nenhum serviço corresponde aos filtros aplicados.
          </EmptyState>
        </div>
      )}

      {visible.map(({ project, environments, next_action }) => (
        <section key={project.id} className="card project-card" aria-label={project.display_name ?? project.name}>
          <div className="card-head">
            {canOperate && (
              <input
                type="checkbox"
                aria-label={`Selecionar ${project.display_name ?? project.name}`}
                checked={selected.includes(project.id)}
                onChange={() => toggle(project.id)}
              />
            )}
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
            {environments.length > 0 && <ProjectSummary cards={environments.flatMap((e) => e.instances)} />}
            {canOperate && (['start', 'stop'] as const).map((kind) => (
              <Button
                key={kind}
                size="sm"
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
              </Button>
            ))}
          </div>
          {environments.length === 0 && (
            <div className="card-body muted">
              Nenhum serviço gerenciado. <Link to={`/projects/${project.id}`}>Importar serviços</Link>
            </div>
          )}
          {environments.length > 0 && (
            <Table label={`Serviços de ${project.display_name ?? project.name}`} className="table-services">
              <thead>
                <tr>
                  <th>Serviço</th>
                  <th>Estado</th>
                  <th>Leitura</th>
                  <th className="actions">Ações</th>
                </tr>
              </thead>
              {environments.map(({ environment, instances }) => (
                <tbody key={environment.id}>
                  <tr className="env-row">
                    <th colSpan={4} scope="colgroup">
                      {environment.name}
                    </th>
                  </tr>
                  {instances.map((card) => (
                    <InstanceRow
                      key={card.id}
                      card={card}
                      disabled={!ready}
                      readOnly={!canOperate}
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
                </tbody>
              ))}
            </Table>
          )}
        </section>
      ))}

      {data && data.recent_operations.length > 0 && (
        <section className="card" style={{ marginTop: 'var(--space-5)' }}>
          <div className="card-head">
            <h3>Últimas operações</h3>
            <span className="spacer" />
            <Link to="/history">Ver histórico</Link>
          </div>
          <Table label="Últimas operações">
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
          </Table>
        </section>
      )}

      {flow && <OperationFlow {...flow} onClose={() => setFlow(null)} />}
    </>
  )
}
