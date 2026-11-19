import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'

import { api, isUuid } from '@/shared/api/client'
import type { InstanceImportReport, InstanceView, PowerKind, PowerTarget, Project } from '@/shared/api/types'
import { ConfirmDialog, Modal } from '@/shared/components/Modal/Modal'
import { OperationFlow } from '@/shared/components/OperationFlow/OperationFlow'
import { FreshnessNote, StateChip } from '@/shared/components/StateChip/StateChip'
import { Button } from '@/shared/ui/Button/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Field, Input, Select } from '@/shared/ui/Field/Field'
import { Table } from '@/shared/ui/Table/Table'
import { Tabs } from '@/shared/ui/Tabs/Tabs'
import { errorMessage } from '@/shared/i18n/errors'
import { useFeedbackMutation } from '@/shared/hooks/useFeedbackMutation'
import { KIND_LABEL, SYNC_LABEL, formatDays, relativeTime } from '@/shared/lib/format'
import { useSession } from '@/features/auth/lib/session'
import { DEFAULT_FILTERS, type LogFilterState, filtersToParams } from '@/features/logs/lib/filters'
import { LogsPanel } from '@/features/logs/components/LogsPanel'

type Flow = { kind: PowerKind; target: PowerTarget; title: string; confirm: boolean }

/** Associação manual: Service ID + Environment ID, validados no Railway. */
export function AssociateForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useTranslation('projects')
  const [service, setService] = useState('')
  const [environment, setEnvironment] = useState('')
  const [touched, setTouched] = useState(false)
  const serviceInvalid = !isUuid(service)
  const environmentInvalid = !isUuid(environment)
  const associate = useFeedbackMutation({
    mutationFn: () =>
      api.associateInstance(projectId, { service_id: service.trim(), environment_id: environment.trim() }),
    success: t('associate.done'),
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
    <form className="stack" onSubmit={submit} aria-label={t('associate.label')}>
      <div className="form-grid">
        <Field label={t('associate.serviceId')} error={touched && serviceInvalid ? t('associate.invalid') : undefined}>
          {(p) => <Input {...p} className="mono" value={service} onChange={(e) => setService(e.target.value)} />}
        </Field>
        <Field label={t('associate.environmentId')} error={touched && environmentInvalid ? t('associate.invalid') : undefined}>
          {(p) => <Input {...p} className="mono" value={environment} onChange={(e) => setEnvironment(e.target.value)} />}
        </Field>
      </div>
      <ErrorState error={associate.error} />
      <div className="row">
        <Button variant="primary" type="submit" loading={associate.isPending}>
          {t('associate.submit')}
        </Button>
      </div>
    </form>
  )
}

function ImportInstances({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation('projects')
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
    success: (r) => t('import.imported', { count: r.imported.length }),
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
        <p className="subtle">{t('import.none')}</p>
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
                {i.managed && <span className="subtle">{t('import.managed')}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )

  return (
    <Modal
      title={t('import.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('ui.close', { ns: 'common' })}</Button>
          <Button variant="primary" disabled={selected.length === 0} loading={importMany.isPending} onClick={() => importMany.mutate()}>
            {t('discover.import', { count: selected.length || '' })}
          </Button>
        </>
      }
    >
      <ErrorState error={discovery.error ?? importMany.error} onRetry={discovery.error ? () => void discovery.refetch() : undefined} />
      {report && (
        <div className="alert alert-success" role="status">
          {t('import.reportImported', { count: report.imported.length })}
          {report.already_managed.length > 0 && t('import.reportAlready', { count: report.already_managed.length })}
          {report.failed.length > 0 && t('import.reportFailed', { count: report.failed.length })}.
        </div>
      )}
      {discovery.isPending && <Skeleton lines={4} label={t('discover.querying')} />}
      {regular.map(renderEnv)}
      {ephemeral.length > 0 && (
        <details>
          <summary className="section-title">{t('import.ephemeral', { count: ephemeral.length })}</summary>
          {ephemeral.map(renderEnv)}
        </details>
      )}
    </Modal>
  )
}

function EditProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation('projects')
  const [name, setName] = useState(project.display_name ?? '')
  const [description, setDescription] = useState(project.description ?? '')
  const save = useFeedbackMutation({
    mutationFn: () => api.editProject(project.id, { display_name: name || null, description: description || null }),
    success: t('edit.done'),
    invalidate: [[]],
    onSuccess: () => onClose(),
  })
  return (
    <Modal
      title={t('edit.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('ui.cancel', { ns: 'common' })}</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            {t('edit.save')}
          </Button>
        </>
      }
    >
      <p className="subtle">{t('edit.hint')}</p>
      <Field label={t('edit.name')}>
        {(p) => <Input {...p} value={name} placeholder={project.name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('edit.description')}>
        {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <ErrorState error={save.error} />
    </Modal>
  )
}

export function ProjectDetail() {
  const { t } = useTranslation('projects')
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

  const sync = useFeedbackMutation({ mutationFn: () => api.syncProject(id), success: t('detail.synced'), invalidate: [[]] })
  const remove = useFeedbackMutation({
    mutationFn: () => api.removeProject(id),
    success: t('detail.unmanaged'),
    invalidate: [[]],
    onSuccess: () => navigate('/projects'),
  })
  const unlink = useFeedbackMutation({
    mutationFn: (instance: string) => api.removeInstance(instance),
    success: t('detail.serviceRemoved'),
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
  if (!p) return <Skeleton lines={4} label={t('detail.loading')} />

  return (
    <>
      <div className="page-head">
        <div>
          <p className="crumb">
            <Link to="/projects">{t('detail.crumb')}</Link> /
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
              {sync.isPending ? t('detail.syncing') : t('detail.sync')}
            </Button>
          )}
          {canManage && <Button onClick={() => setModal('edit')}>{t('detail.edit')}</Button>}
          {canManage && (
            <Button variant="ghost" onClick={() => setModal('remove')}>
              {t('detail.unmanage')}
            </Button>
          )}
        </div>
      </div>

      <div className="stack">
        <ErrorState error={instances.error} onRetry={() => void instances.refetch()} />
        {p.sync_status === 'not_found' && (
          <div className="alert alert-danger">{t('detail.gone')}</div>
        )}

        <Tabs
          label={t('detail.sections')}
          value={tab}
          onChange={setTab}
          items={[
            { id: 'services', label: t('detail.tabServices'), count: views.length },
            { id: 'environments', label: t('detail.tabEnvironments'), count: environments.data?.environments.length },
            { id: 'schedules', label: t('detail.tabSchedules'), count: schedules.data?.schedules.length },
          ]}
        />

        {tab === 'environments' && (
          <div className="card">
            {!environments.data ? (
              <Skeleton lines={3} />
            ) : environments.data.environments.length === 0 ? (
              <EmptyState title={t('detail.noEnvironments')}>{t('detail.noEnvironmentsBody')}</EmptyState>
            ) : (
              <Table label={t('detail.envTable')}>
                <thead>
                  <tr>
                    <th>{t('detail.environment')}</th>
                    <th>{t('detail.type')}</th>
                    <th className="num">{t('detail.managedServices')}</th>
                  </tr>
                </thead>
                <tbody>
                  {environments.data.environments.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.name}</td>
                      <td>{e.is_ephemeral ? t('detail.ephemeralPr') : t('detail.permanent')}</td>
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
                title={t('detail.noSchedules')}
                action={
                  <Link to="/schedules" className="btn">
                    {t('detail.goSchedules')}
                  </Link>
                }
              >
                {t('detail.noSchedulesBody')}
              </EmptyState>
            ) : (
              <Table label={t('detail.schedulesTable')}>
                <thead>
                  <tr>
                    <th>{t('detail.schedule')}</th>
                    <th>{t('detail.days')}</th>
                    <th>{t('detail.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.data?.schedules.map(({ schedule: sc }) => (
                    <tr key={sc.id}>
                      <td>
                        <Link to="/schedules">{sc.name}</Link>
                      </td>
                      <td>{formatDays(sc.days)}</td>
                      <td>{sc.paused_reason ? t('detail.paused') : sc.enabled ? t('detail.active') : t('detail.disabled')}</td>
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
            <h3>{t('detail.services')}</h3>
            <Select
              style={{ width: 'auto' }}
              aria-label={t('detail.filterEnv')}
              value={envFilter}
              onChange={(e) => setEnvFilter(e.target.value)}
            >
              <option value="">{t('detail.allEnvs')}</option>
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
                    title: t(envFilter ? 'detail.titleEnv' : 'detail.titleAll', { kind: KIND_LABEL[kind], name }),
                    confirm: true,
                  })
                }
              >
                {t(kind === 'start' ? (envFilter ? 'detail.startEnv' : 'detail.startAll') : envFilter ? 'detail.stopEnv' : 'detail.stopAll')}
              </Button>
            ))}
            {canManage && (
              <>
                <Button size="sm" onClick={() => setModal('associate')}>
                  {t('detail.associateById')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => setModal('import')} disabled={!ready}>
                  {t('detail.importFromRailway')}
                </Button>
              </>
            )}
          </div>
          {views.length === 0 ? (
            <EmptyState title={t('detail.noServices')}>{t('detail.noServicesBody')}</EmptyState>
          ) : (
            <Table label={t('detail.servicesTable')}>
                <thead>
                  <tr>
                    <th>{t('detail.service')}</th>
                    <th>{t('detail.environment')}</th>
                    <th>{t('detail.state')}</th>
                    <th>{t('detail.reading')}</th>
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
                            <span className="freshness freshness-unavailable">{t('detail.notFound')}</span>
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
                                  title: t('detail.actionTitle', { kind: off ? t('detail.start') : t('detail.stop'), service: v.service.name, environment: v.environment.name }),
                                  confirm: false,
                                })
                              }
                            >
                              {off ? t('detail.start') : t('detail.stop')}
                            </Button>
                            )}
                            <Button
                              size="sm"
                              aria-label={t('detail.logsOf', { service: v.service.name, environment: v.environment.name })}
                              aria-pressed={logsFor?.instance.id === v.instance.id}
                              disabled={v.instance.not_found}
                              onClick={() => {
                                setLogFilters(DEFAULT_FILTERS)
                                setLogsFor(logsFor?.instance.id === v.instance.id ? null : v)
                              }}
                            >
                              {t('detail.logs')}
                            </Button>
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => setRemoveInstance(v)}>
                                {t('detail.remove')}
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
              title={t('detail.logsOf', { service: logsFor.service.name, environment: logsFor.environment.name })}
              actions={
                <>
                  <Link
                    className="btn btn-sm"
                    to={`/logs?${filtersToParams(logFilters, new URLSearchParams({ instance: logsFor.instance.id })).toString()}`}
                  >
                    {t('detail.fullScreen')}
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => setLogsFor(null)}>
                    {t('detail.close')}
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
        <Modal title={t('detail.associateTitle')} onClose={() => setModal(null)}>
          <AssociateForm projectId={id} onDone={() => setModal(null)} />
        </Modal>
      )}
      {modal === 'edit' && <EditProject project={p} onClose={() => setModal(null)} />}
      {modal === 'remove' && (
        <ConfirmDialog
          title={t('detail.removeTitle')}
          message={
            <>
              <p>
                <Trans t={t} i18nKey="detail.removeBody" values={{ name }} components={{ 1: <strong /> }} />
              </p>
              <p className="muted">{t('detail.removeNote')}</p>
            </>
          }
          confirmLabel={t('detail.confirmRemove')}
          danger
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => setModal(null)}
        />
      )}
      {removeInstance && (
        <ConfirmDialog
          title={t('detail.removeServiceTitle')}
          message={
            <p>
              <Trans
                t={t}
                i18nKey="detail.unlink"
                values={{ service: removeInstance.service.name, environment: removeInstance.environment.name }}
                components={{ 1: <strong /> }}
              />
            </p>
          }
          confirmLabel={t('detail.confirmRemove')}
          danger
          busy={unlink.isPending}
          error={unlink.error ? errorMessage(unlink.error) : undefined}
          onConfirm={() => unlink.mutate(removeInstance.instance.id)}
          onClose={() => setRemoveInstance(null)}
        />
      )}
      {flow && <OperationFlow {...flow} onClose={() => setFlow(null)} />}
    </>
  )
}
