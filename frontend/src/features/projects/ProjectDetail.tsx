import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { api, isUuid } from '@/shared/api/client'
import type { InstanceImportReport, InstanceView, PowerKind, PowerTarget, Project } from '@/shared/api/types'
import { ConfirmDialog, Modal } from '@/shared/components/Modal'
import { OperationFlow } from '@/shared/components/OperationFlow'
import { FreshnessNote, StateChip } from '@/shared/components/StateChip'
import { Button } from '@/shared/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback'
import { Field, Input, Select } from '@/shared/ui/Field'
import { Table } from '@/shared/ui/Table'
import { Tabs } from '@/shared/ui/Tabs'
import { useFeedbackMutation } from '@/shared/components/useFeedbackMutation'
import { KIND_LABEL, SYNC_LABEL, formatDays, relativeTime } from '@/shared/lib/format'
import { useSession } from '../auth/session'
import { DEFAULT_FILTERS, type LogFilterState, filtersToParams } from '../logs/filters'
import { LogsPanel } from '../logs/LogsPanel'

type Flow = { kind: PowerKind; target: PowerTarget; title: string; confirm: boolean }

/** Associação manual: Service ID + Environment ID, validados no Railway. */
export function AssociateForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [service, setService] = useState('')
  const [environment, setEnvironment] = useState('')
  const [touched, setTouched] = useState(false)
  const serviceInvalid = !isUuid(service)
  const environmentInvalid = !isUuid(environment)
  const associate = useFeedbackMutation({
    mutationFn: () =>
      api.associateInstance(projectId, { service_id: service.trim(), environment_id: environment.trim() }),
    success: 'Serviço associado.',
    invalidate: [[]],
    onSuccess: () => onDone(),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (serviceInvalid || environmentInvalid) return
    associate.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Associar serviço">
      <div className="form-grid">
        <Field label="Railway Service ID" error={touched && serviceInvalid ? 'UUID inválido.' : undefined}>
          {(p) => <Input {...p} className="mono" value={service} onChange={(e) => setService(e.target.value)} />}
        </Field>
        <Field label="Railway Environment ID" error={touched && environmentInvalid ? 'UUID inválido.' : undefined}>
          {(p) => <Input {...p} className="mono" value={environment} onChange={(e) => setEnvironment(e.target.value)} />}
        </Field>
      </div>
      <ErrorState error={associate.error} />
      <div className="row">
        <Button variant="primary" type="submit" loading={associate.isPending}>
          Associar
        </Button>
      </div>
    </form>
  )
}

function ImportInstances({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const discovery = useQuery({
    queryKey: ['discover-instances', projectId],
    queryFn: () => api.discoverInstances(projectId),
  })
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<InstanceImportReport | null>(null)
  const key = (env: string, service: string) => `${env}|${service}`
  const importMany = useFeedbackMutation({
    mutationFn: () =>
      api.importInstances(
        projectId,
        selected.map((k) => {
          const [environment_id, service_id] = k.split('|')
          return { environment_id, service_id }
        }),
      ),
    success: (r) => `${r.imported.length} serviço(s) importado(s).`,
    invalidate: [[]],
    onSuccess: (r) => {
      setReport(r)
      setSelected([])
    },
  })
  const toggle = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))
  const regular = discovery.data?.environments.filter((e) => !e.environment.is_ephemeral) ?? []
  const ephemeral = discovery.data?.environments.filter((e) => e.environment.is_ephemeral) ?? []

  const renderEnv = (env: (typeof regular)[number]) => (
    <div key={env.environment.id}>
      <div className="group-title">{env.environment.name}</div>
      {env.instances.length === 0 ? (
        <p className="subtle">Nenhum serviço neste ambiente.</p>
      ) : (
        <ul className="check-list">
          {env.instances.map((i) => {
            const k = key(env.environment.id, i.service_id)
            return (
              <li key={k}>
                <label>
                  <input
                    type="checkbox"
                    disabled={i.managed}
                    checked={i.managed || selected.includes(k)}
                    onChange={() => toggle(k)}
                  />
                  <span>{i.service_name}</span>
                </label>
                <StateChip state={i.state} />
                {i.managed && <span className="subtle">já gerenciado</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )

  return (
    <Modal
      title="Importar serviços do Railway"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" disabled={selected.length === 0} loading={importMany.isPending} onClick={() => importMany.mutate()}>
            Importar {selected.length || ''}
          </Button>
        </>
      }
    >
      <ErrorState error={discovery.error ?? importMany.error} onRetry={discovery.error ? () => void discovery.refetch() : undefined} />
      {report && (
        <div className="alert alert-success" role="status">
          {report.imported.length} importada(s)
          {report.already_managed.length > 0 && `, ${report.already_managed.length} já gerenciada(s)`}
          {report.failed.length > 0 && `, ${report.failed.length} com falha`}.
        </div>
      )}
      {discovery.isPending && <Skeleton lines={4} label="Consultando o Railway…" />}
      {regular.map(renderEnv)}
      {ephemeral.length > 0 && (
        <details>
          <summary className="section-title">Ambientes efêmeros (PR) — {ephemeral.length}</summary>
          {ephemeral.map(renderEnv)}
        </details>
      )}
    </Modal>
  )
}

function EditProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.display_name ?? '')
  const [description, setDescription] = useState(project.description ?? '')
  const save = useFeedbackMutation({
    mutationFn: () => api.editProject(project.id, { display_name: name || null, description: description || null }),
    success: 'Projeto atualizado.',
    invalidate: [[]],
    onSuccess: () => onClose(),
  })
  return (
    <Modal
      title="Editar projeto"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <p className="subtle">Altera apenas os dados locais. O Railway Project ID não é editável.</p>
      <Field label="Nome de exibição">
        {(p) => <Input {...p} value={name} placeholder={project.name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Descrição">
        {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <ErrorState error={save.error} />
    </Modal>
  )
}

export function ProjectDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const session = useSession()
  const canOperate = session.can('operator')
  const canManage = session.can('admin')
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id) })
  const instances = useQuery({ queryKey: ['instances', id], queryFn: () => api.instances(id) })
  const environments = useQuery({ queryKey: ['environments', id], queryFn: () => api.environments(id) })
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })
  const [modal, setModal] = useState<'import' | 'associate' | 'edit' | 'remove' | null>(null)
  const [removeInstance, setRemoveInstance] = useState<InstanceView | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [logsFor, setLogsFor] = useState<InstanceView | null>(null)
  const [logFilters, setLogFilters] = useState<LogFilterState>(DEFAULT_FILTERS)
  const [envFilter, setEnvFilter] = useState('')
  const [tab, setTab] = useState('services')

  const sync = useFeedbackMutation({ mutationFn: () => api.syncProject(id), success: 'Projeto sincronizado.', invalidate: [[]] })
  const remove = useFeedbackMutation({
    mutationFn: () => api.removeProject(id),
    success: 'Projeto removido do gerenciamento.',
    invalidate: [[]],
    onSuccess: () => navigate('/projects'),
  })
  const unlink = useFeedbackMutation({
    mutationFn: (instance: string) => api.removeInstance(instance),
    success: 'Serviço removido.',
    invalidate: [[]],
    onSuccess: () => setRemoveInstance(null),
  })
  const schedules = useQuery({ queryKey: ['schedules', id], queryFn: () => api.schedules(id), enabled: tab === 'schedules' })

  const p = project.data?.project
  const ready = dashboard.data?.integration_ready ?? false
  const cards = new Map(
    dashboard.data?.projects
      .find((c) => c.project.id === id)
      ?.environments.flatMap((e) => e.instances)
      .map((c) => [c.id, c]),
  )
  const views = instances.data?.instances ?? []
  const shown = envFilter ? views.filter((v) => v.environment.id === envFilter) : views
  const name = p?.display_name ?? p?.name ?? ''

  if (project.error) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />
  if (!p) return <Skeleton lines={4} label="Carregando projeto…" />

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link to="/projects">Projetos</Link> /
          </p>
          <h1>{name}</h1>
          <p className="muted">
            <span className="mono">{p.railway_project_id}</span> · {SYNC_LABEL[p.sync_status]} {relativeTime(p.last_synced_at)}
          </p>
          {p.description && <p className="muted">{p.description}</p>}
        </div>
        <div className="row">
          {canOperate && (
            <Button onClick={() => sync.mutate()} loading={sync.isPending} disabled={!ready}>
              {sync.isPending ? 'Sincronizando…' : 'Sincronizar'}
            </Button>
          )}
          {canManage && <Button onClick={() => setModal('edit')}>Editar</Button>}
          {canManage && (
            <Button variant="ghost" onClick={() => setModal('remove')}>
              Remover do gerenciamento
            </Button>
          )}
        </div>
      </div>

      <div className="stack">
        <ErrorState error={instances.error} onRetry={() => void instances.refetch()} />
        {p.sync_status === 'not_found' && (
          <div className="alert alert-danger">O Railway informa que este projeto não existe mais. Os dados locais foram mantidos.</div>
        )}

        <Tabs
          label="Seções do projeto"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'services', label: 'Serviços', count: views.length },
            { id: 'environments', label: 'Ambientes', count: environments.data?.environments.length },
            { id: 'schedules', label: 'Agendas', count: schedules.data?.schedules.length },
          ]}
        />

        {tab === 'environments' && (
          <div className="card">
            {!environments.data ? (
              <Skeleton lines={3} />
            ) : environments.data.environments.length === 0 ? (
              <EmptyState title="Nenhum ambiente">Sincronize o projeto para carregar os ambientes.</EmptyState>
            ) : (
              <Table label="Ambientes">
                <thead>
                  <tr>
                    <th>Ambiente</th>
                    <th>Tipo</th>
                    <th className="num">Serviços gerenciados</th>
                  </tr>
                </thead>
                <tbody>
                  {environments.data.environments.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.name}</td>
                      <td>{e.is_ephemeral ? 'Efêmero (PR)' : 'Permanente'}</td>
                      <td className="num">{views.filter((v) => v.environment.id === e.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}

        {tab === 'schedules' && (
          <div className="card">
            <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
            {schedules.isPending ? (
              <Skeleton lines={3} />
            ) : schedules.data && schedules.data.schedules.length === 0 ? (
              <EmptyState
                title="Nenhuma agenda neste projeto"
                action={
                  <Link to="/schedules" className="btn">
                    Ir para Agendas
                  </Link>
                }
              >
                Agendas ligam e desligam os serviços automaticamente em horários definidos.
              </EmptyState>
            ) : (
              <Table label="Agendas do projeto">
                <thead>
                  <tr>
                    <th>Agenda</th>
                    <th>Dias</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.data?.schedules.map(({ schedule: sc }) => (
                    <tr key={sc.id}>
                      <td>
                        <Link to="/schedules">{sc.name}</Link>
                      </td>
                      <td>{formatDays(sc.days)}</td>
                      <td>{sc.paused_reason ? 'Pausada' : sc.enabled ? 'Ativa' : 'Desativada'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}

        {tab === 'services' && (
        <div className="card">
          <div className="card-head">
            <h3>Serviços</h3>
            <Select
              style={{ width: 'auto' }}
              aria-label="Filtrar por ambiente"
              value={envFilter}
              onChange={(e) => setEnvFilter(e.target.value)}
            >
              <option value="">Todos os ambientes</option>
              {environments.data?.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
            <span className="spacer" />
            {canOperate && (['start', 'stop'] as const).map((kind) => (
              <Button
                key={kind}
                size="sm"
                disabled={!ready || shown.length === 0}
                onClick={() =>
                  setFlow({
                    kind,
                    target: { type: 'project', project_id: id, environment_id: envFilter || null },
                    title: `${KIND_LABEL[kind]} ${envFilter ? 'ambiente' : 'todos'} — ${name}`,
                    confirm: true,
                  })
                }
              >
                {kind === 'start' ? 'Iniciar' : 'Desligar'} {envFilter ? 'ambiente' : 'todos'}
              </Button>
            ))}
            {canManage && (
              <>
                <Button size="sm" onClick={() => setModal('associate')}>
                  Associar por ID
                </Button>
                <Button size="sm" variant="primary" onClick={() => setModal('import')} disabled={!ready}>
                  Importar do Railway
                </Button>
              </>
            )}
          </div>
          {views.length === 0 ? (
            <EmptyState title="Nenhum serviço gerenciado">Importe serviços de um ambiente para controlar desligar/iniciar.</EmptyState>
          ) : (
            <Table label="Serviços">
                <thead>
                  <tr>
                    <th>Serviço</th>
                    <th>Ambiente</th>
                    <th>Estado</th>
                    <th>Leitura</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((v) => {
                    const card = cards.get(v.instance.id)
                    const freshness = card?.freshness ?? 'stale'
                    const off = v.instance.observed_state === 'stopped' || v.instance.observed_state === 'failed'
                    return (
                      <tr key={v.instance.id}>
                        <td>
                          {v.service.name}
                          <div className="subtle mono">{v.service.railway_service_id.slice(0, 8)}</div>
                        </td>
                        <td>{v.environment.name}</td>
                        <td>
                          <StateChip state={v.instance.observed_state} freshness={freshness} />
                        </td>
                        <td>
                          {v.instance.not_found ? (
                            <span className="freshness freshness-unavailable">Não encontrado no Railway</span>
                          ) : (
                            <FreshnessNote
                              freshness={freshness}
                              observedAt={v.instance.last_observed_at}
                              error={v.instance.last_sync_error}
                            />
                          )}
                        </td>
                        <td className="num">
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            {canOperate && (
                            <Button
                              size="sm"
                              disabled={!ready || v.instance.not_found || card?.busy}
                              onClick={() =>
                                setFlow({
                                  kind: off ? 'start' : 'stop',
                                  target: { type: 'instance', instance_id: v.instance.id },
                                  title: `${off ? 'Iniciar' : 'Desligar'} ${v.service.name} (${v.environment.name})`,
                                  confirm: false,
                                })
                              }
                            >
                              {off ? 'Iniciar' : 'Desligar'}
                            </Button>
                            )}
                            <Button
                              size="sm"
                              aria-label={`Logs de ${v.service.name} (${v.environment.name})`}
                              aria-pressed={logsFor?.instance.id === v.instance.id}
                              disabled={v.instance.not_found}
                              onClick={() => {
                                setLogFilters(DEFAULT_FILTERS)
                                setLogsFor(logsFor?.instance.id === v.instance.id ? null : v)
                              }}
                            >
                              Logs
                            </Button>
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => setRemoveInstance(v)}>
                                Remover
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
            </Table>
          )}
          {logsFor && (
            <LogsPanel
              // Trocar de serviço recomeça o painel (filtros e acompanhamento).
              key={logsFor.instance.id}
              instanceId={logsFor.instance.id}
              filters={logFilters}
              onChange={setLogFilters}
              fileName={`${name}-${logsFor.service.name}-${logsFor.environment.name}`}
              title={`Logs de ${logsFor.service.name} (${logsFor.environment.name})`}
              actions={
                <>
                  <Link
                    className="btn btn-sm"
                    to={`/logs?${filtersToParams(logFilters, new URLSearchParams({ instance: logsFor.instance.id })).toString()}`}
                  >
                    Abrir em tela cheia
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => setLogsFor(null)}>
                    Fechar
                  </Button>
                </>
              }
            />
          )}
        </div>
        )}
      </div>

      {modal === 'import' && <ImportInstances projectId={id} onClose={() => setModal(null)} />}
      {modal === 'associate' && (
        <Modal title="Associar serviço" onClose={() => setModal(null)}>
          <AssociateForm projectId={id} onDone={() => setModal(null)} />
        </Modal>
      )}
      {modal === 'edit' && <EditProject project={p} onClose={() => setModal(null)} />}
      {modal === 'remove' && (
        <ConfirmDialog
          title="Remover do gerenciamento"
          message={
            <>
              <p>
                <strong>{name}</strong> sai da lista local com seus ambientes e serviços.
              </p>
              <p className="muted">Nada é alterado no Railway. O histórico de operações é mantido.</p>
            </>
          }
          confirmLabel="Remover"
          danger
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate()}
          onClose={() => setModal(null)}
        />
      )}
      {removeInstance && (
        <ConfirmDialog
          title="Remover serviço"
          message={
            <p>
              Desvincular <strong>{removeInstance.service.name}</strong> em <strong>{removeInstance.environment.name}</strong>?
              O serviço continua rodando no Railway.
            </p>
          }
          confirmLabel="Remover"
          danger
          busy={unlink.isPending}
          error={unlink.error?.message}
          onConfirm={() => unlink.mutate(removeInstance.instance.id)}
          onClose={() => setRemoveInstance(null)}
        />
      )}
      {flow && <OperationFlow {...flow} onClose={() => setFlow(null)} />}
    </>
  )
}
