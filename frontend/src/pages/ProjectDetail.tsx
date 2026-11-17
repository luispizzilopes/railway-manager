import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { api, isUuid } from '../api/client'
import type { InstanceImportReport, InstanceView, PowerKind, PowerTarget, Project } from '../api/types'
import { ConfirmDialog, ErrorAlert, Modal } from '../components/Modal'
import { OperationFlow } from '../components/OperationFlow'
import { FreshnessNote, StateChip } from '../components/StateChip'
import { KIND_LABEL, SYNC_LABEL, relativeTime } from '../format'

type Flow = { kind: PowerKind; target: PowerTarget; title: string; confirm: boolean }

/** Associação manual: Service ID + Environment ID, validados no Railway. */
export function AssociateForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [service, setService] = useState('')
  const [environment, setEnvironment] = useState('')
  const [touched, setTouched] = useState(false)
  const serviceInvalid = !isUuid(service)
  const environmentInvalid = !isUuid(environment)
  const associate = useMutation({
    mutationFn: () =>
      api.associateInstance(projectId, { service_id: service.trim(), environment_id: environment.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onDone()
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (serviceInvalid || environmentInvalid) return
    associate.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Associar instância">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="service-id">Railway Service ID</label>
          <input
            id="service-id"
            className="input mono"
            value={service}
            onChange={(e) => setService(e.target.value)}
            aria-invalid={touched && serviceInvalid}
          />
          {touched && serviceInvalid && <span className="error-text">UUID inválido.</span>}
        </div>
        <div className="field">
          <label htmlFor="environment-id">Railway Environment ID</label>
          <input
            id="environment-id"
            className="input mono"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-invalid={touched && environmentInvalid}
          />
          {touched && environmentInvalid && <span className="error-text">UUID inválido.</span>}
        </div>
      </div>
      <ErrorAlert error={associate.error} />
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={associate.isPending}>
          Associar
        </button>
      </div>
    </form>
  )
}

function ImportInstances({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const discovery = useQuery({
    queryKey: ['discover-instances', projectId],
    queryFn: () => api.discoverInstances(projectId),
  })
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<InstanceImportReport | null>(null)
  const key = (env: string, service: string) => `${env}|${service}`
  const importMany = useMutation({
    mutationFn: () =>
      api.importInstances(
        projectId,
        selected.map((k) => {
          const [environment_id, service_id] = k.split('|')
          return { environment_id, service_id }
        }),
      ),
    onSuccess: (r) => {
      setReport(r)
      setSelected([])
      void queryClient.invalidateQueries()
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
      title="Importar instâncias do Railway"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0 || importMany.isPending}
            onClick={() => importMany.mutate()}
          >
            Importar {selected.length || ''}
          </button>
        </>
      }
    >
      <ErrorAlert error={discovery.error ?? importMany.error} />
      {report && (
        <div className="alert alert-success" role="status">
          {report.imported.length} importada(s)
          {report.already_managed.length > 0 && `, ${report.already_managed.length} já gerenciada(s)`}
          {report.failed.length > 0 && `, ${report.failed.length} com falha`}.
        </div>
      )}
      {discovery.isPending && <p className="muted">Consultando o Railway…</p>}
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
  const queryClient = useQueryClient()
  const [name, setName] = useState(project.display_name ?? '')
  const [description, setDescription] = useState(project.description ?? '')
  const save = useMutation({
    mutationFn: () => api.editProject(project.id, { display_name: name || null, description: description || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onClose()
    },
  })
  return (
    <Modal
      title="Editar projeto"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </button>
        </>
      }
    >
      <p className="subtle">Altera apenas os dados locais. O Railway Project ID não é editável.</p>
      <div className="field">
        <label htmlFor="edit-name">Nome de exibição</label>
        <input
          id="edit-name"
          className="input"
          value={name}
          placeholder={project.name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="edit-description">Descrição</label>
        <input id="edit-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <ErrorAlert error={save.error} />
    </Modal>
  )
}

export function ProjectDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id) })
  const instances = useQuery({ queryKey: ['instances', id], queryFn: () => api.instances(id) })
  const environments = useQuery({ queryKey: ['environments', id], queryFn: () => api.environments(id) })
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })
  const [modal, setModal] = useState<'import' | 'associate' | 'edit' | 'remove' | null>(null)
  const [removeInstance, setRemoveInstance] = useState<InstanceView | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [envFilter, setEnvFilter] = useState('')

  const sync = useMutation({ mutationFn: () => api.syncProject(id), onSettled: () => queryClient.invalidateQueries() })
  const remove = useMutation({
    mutationFn: () => api.removeProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      navigate('/projects')
    },
  })
  const unlink = useMutation({
    mutationFn: (instance: string) => api.removeInstance(instance),
    onSuccess: () => {
      setRemoveInstance(null)
      void queryClient.invalidateQueries()
    },
  })

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

  if (project.error) return <ErrorAlert error={project.error} />
  if (!p) return <p className="muted">Carregando…</p>

  return (
    <>
      <div className="page-head">
        <div>
          <p className="subtle">
            <Link to="/projects">Projetos</Link> /
          </p>
          <h1>{name}</h1>
          <p className="muted">
            <span className="mono">{p.railway_project_id}</span> · {SYNC_LABEL[p.sync_status]} {relativeTime(p.last_synced_at)}
          </p>
          {p.description && <p className="muted">{p.description}</p>}
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => sync.mutate()} disabled={sync.isPending || !ready}>
            {sync.isPending ? 'Sincronizando…' : 'Sincronizar'}
          </button>
          <button type="button" className="btn" onClick={() => setModal('edit')}>
            Editar
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setModal('remove')}>
            Remover do gerenciamento
          </button>
        </div>
      </div>

      <div className="stack">
        <ErrorAlert error={sync.error ?? instances.error} />
        {p.sync_status === 'not_found' && (
          <div className="alert alert-danger">O Railway informa que este projeto não existe mais. Os dados locais foram mantidos.</div>
        )}

        <div className="card">
          <div className="card-head">
            <h3>Instâncias</h3>
            <select
              className="select"
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
            </select>
            <span className="spacer" />
            {(['start', 'stop'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn btn-sm"
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
              </button>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setModal('associate')}>
              Associar por ID
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setModal('import')} disabled={!ready}>
              Importar do Railway
            </button>
          </div>
          {views.length === 0 ? (
            <div className="empty">
              <h3>Nenhuma instância gerenciada</h3>
              <p>Importe serviços de um ambiente para controlar desligar/iniciar.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
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
                            <button
                              type="button"
                              className="btn btn-sm"
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
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoveInstance(v)}>
                              Remover
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {modal === 'import' && <ImportInstances projectId={id} onClose={() => setModal(null)} />}
      {modal === 'associate' && (
        <Modal title="Associar instância" onClose={() => setModal(null)}>
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
                <strong>{name}</strong> sai da lista local com seus ambientes, serviços e instâncias.
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
          title="Remover instância"
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
