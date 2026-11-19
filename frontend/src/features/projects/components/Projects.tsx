import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { api, isUuid } from '@/shared/api/client'
import type { ProjectImportReport } from '@/shared/api/types'
import { Modal } from '@/shared/components/Modal/Modal'
import { Button } from '@/shared/ui/Button/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Field, Input } from '@/shared/ui/Field/Field'
import { Table } from '@/shared/ui/Table/Table'
import { useFeedbackMutation } from '@/shared/hooks/useFeedbackMutation'
import { SYNC_LABEL, relativeTime } from '@/shared/lib/format'
import { useSession } from '@/features/auth/lib/session'

/** Cadastro manual por Railway Project ID. */
export function RegisterProjectForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('projects')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const invalid = id.trim() !== '' && !isUuid(id)
  const create = useFeedbackMutation({
    mutationFn: () => api.createProject(id.trim(), name.trim() || undefined),
    success: t('register.done'),
    invalidate: [[]],
    onSuccess: () => onDone(),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!isUuid(id)) return
    create.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label={t('register.label')}>
      <Field
        label={t('register.id')}
        error={touched && (invalid || !id.trim()) ? t('register.idError') : undefined}
      >
        {(p) => (
          <Input
            {...p}
            className="mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        )}
      </Field>
      <Field label={t('register.name')} hint={t('register.nameHint')}>
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <ErrorState error={create.error} />
      <div className="row">
        <Button variant="primary" type="submit" loading={create.isPending}>
          {create.isPending ? t('register.validating') : t('register.submit')}
        </Button>
      </div>
    </form>
  )
}

function DiscoverProjects({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('projects')
  const discovery = useQuery({ queryKey: ['discover-projects'], queryFn: api.discoverProjects })
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<ProjectImportReport | null>(null)
  const importMany = useFeedbackMutation({
    mutationFn: () => api.importProjects(selected),
    success: (r) => t('discover.imported', { count: r.imported.length }),
    invalidate: [[]],
    onSuccess: (r) => {
      setReport(r)
      setSelected([])
    },
  })
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Modal
      title={t('discover.title')}
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
      <ErrorState error={discovery.error} onRetry={() => void discovery.refetch()} />
      {report && (
        <div className="alert alert-success" role="status">
          {t('discover.reportImported', { count: report.imported.length })}
          {report.already_managed.length > 0 && t('discover.reportAlready', { count: report.already_managed.length })}
          {report.failed.length > 0 && t('discover.reportFailed', { count: report.failed.length, reasons: report.failed.map((f) => f.reason).join('; ') })}.
        </div>
      )}
      {discovery.isPending && <Skeleton lines={4} label={t('discover.querying')} />}
      {discovery.data?.workspaces.map((group) => (
        <div key={group.workspace?.id ?? 'sem-workspace'}>
          <div className="group-title">{group.workspace?.name ?? t('discover.noWorkspace')}</div>
          {group.projects.length === 0 ? (
            <p className="subtle">{t('discover.noProjects')}</p>
          ) : (
            <ul className="check-list">
              {group.projects.map(({ project, managed }) => (
                <li key={project.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={managed}
                      checked={managed || selected.includes(project.id)}
                      onChange={() => toggle(project.id)}
                    />
                    <span>{project.name}</span>
                    <span className="subtle mono">{project.id.slice(0, 8)}</span>
                  </label>
                  {managed && <span className="subtle">{t('discover.managed')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </Modal>
  )
}

export function Projects() {
  const { t } = useTranslation('projects')
  const canManage = useSession().can('admin')
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const [mode, setMode] = useState<'discover' | 'manual' | null>(null)
  const [filter, setFilter] = useState('')
  const all = projects.data?.projects ?? []
  const q = filter.trim().toLowerCase()
  const shown = q ? all.filter((p) => (p.display_name ?? p.name).toLowerCase().includes(q)) : all

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('list.title')}</h1>
          <p className="muted">{t('list.subtitle')}</p>
        </div>
        {canManage && (
          <div className="row">
            <Button onClick={() => setMode('manual')}>{t('list.registerById')}</Button>
            <Button variant="primary" onClick={() => setMode('discover')}>
              {t('list.importAccount')}
            </Button>
          </div>
        )}
      </div>
      <ErrorState error={projects.error} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />
      {projects.isPending && (
        <div className="card">
          <Skeleton lines={4} label={t('list.loading')} />
        </div>
      )}
      {projects.data && all.length === 0 && (
        <div className="card">
          <EmptyState
            title={t('list.emptyTitle')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setMode('discover')}>
                  {t('list.importAccount')}
                </Button>
              ) : undefined
            }
          >
            {canManage ? t('list.emptyAdmin') : t('list.emptyViewer')}
          </EmptyState>
        </div>
      )}
      {all.length > 0 && (
        <div className="toolbar" role="search" style={{ marginBottom: 'var(--space-3)' }}>
          <Input type="search" aria-label={t('list.search')} placeholder={t('list.searchPlaceholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="toolbar-count" aria-live="polite">
            {t('list.count', { count: shown.length })}
          </span>
        </div>
      )}
      {all.length > 0 && (
        <div className="card">
          {shown.length === 0 ? (
            <EmptyState title={t('list.noneTitle')} action={<Button onClick={() => setFilter('')}>{t('list.clearSearch')}</Button>}>
              {t('list.noneBody')}
            </EmptyState>
          ) : (
            <Table label={t('list.table')}>
              <thead>
                <tr>
                  <th>{t('list.project')}</th>
                  <th>{t('list.railwayId')}</th>
                  <th>{t('list.sync')}</th>
                  <th>{t('list.registered')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}`}>{p.display_name ?? p.name}</Link>
                      {p.description && <div className="subtle">{p.description}</div>}
                    </td>
                    <td className="mono">{p.railway_project_id}</td>
                    <td>
                      <span className={p.sync_status === 'ok' ? '' : 'result result-failed'}>{SYNC_LABEL[p.sync_status]}</span>
                      <div className="subtle">{relativeTime(p.last_synced_at)}</div>
                    </td>
                    <td>{relativeTime(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
      {mode === 'discover' && <DiscoverProjects onClose={() => setMode(null)} />}
      {mode === 'manual' && (
        <Modal title={t('register.label')} onClose={() => setMode(null)}>
          <RegisterProjectForm onDone={() => setMode(null)} />
        </Modal>
      )}
    </>
  )
}
