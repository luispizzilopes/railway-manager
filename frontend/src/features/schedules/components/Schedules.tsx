import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import { ApiError, api } from '@/shared/api/client'
import type { Project, ScheduleInput, ScheduleView, ScheduleWindow } from '@/shared/api/types'
import { ConfirmDialog, Modal } from '@/shared/components/Modal/Modal'
import { i18n } from '@/shared/i18n'
import { errorMessage } from '@/shared/i18n/errors'
import { useFeedbackMutation } from '@/shared/hooks/useFeedbackMutation'
import { OperationResult } from '@/shared/components/OperationFlow/OperationFlow'
import { DAY_LABEL, KIND_LABEL, RUN_LABEL, formatDays, formatInZone } from '@/shared/lib/format'
import { useSession } from '@/features/auth/lib/session'
import { Button } from '@/shared/ui/Button/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Input, Select } from '@/shared/ui/Field/Field'
import { Table } from '@/shared/ui/Table/Table'
import { Tabs } from '@/shared/ui/Tabs/Tabs'

/** Fusos mais usados; o campo aceita qualquer nome IANA. */
export const COMMON_TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Fortaleza',
  'America/Recife',
  'America/Belem',
  'America/Cuiaba',
  'America/Rio_Branco',
  'America/Noronha',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'UTC',
]

const projectName = (projects: Project[] | undefined, id: string) => {
  const p = projects?.find((x) => x.id === id)
  return p ? (p.display_name ?? p.name) : '—'
}

function windowsLabel(windows: ScheduleWindow[]): string {
  return windows.map((w) => `${w.start}–${w.end}`).join(', ')
}

// ---------- editor ----------

interface Draft {
  project_id: string
  name: string
  timezone: string
  days: number[]
  windows: ScheduleWindow[]
  targetType: 'project' | 'instances'
  environment_id: string
  instance_ids: string[]
}

function draftFrom(view: ScheduleView | null, defaultTimezone: string, projectId: string): Draft {
  if (!view) {
    return {
      project_id: projectId,
      name: '',
      timezone: defaultTimezone,
      days: [0, 1, 2, 3, 4],
      windows: [{ start: '07:00', end: '12:00' }],
      targetType: 'project',
      environment_id: '',
      instance_ids: [],
    }
  }
  const s = view.schedule
  return {
    project_id: s.project_id,
    name: s.name,
    timezone: s.timezone,
    days: s.days,
    windows: s.windows,
    targetType: s.target.type,
    environment_id: s.target.type === 'project' ? (s.target.environment_id ?? '') : '',
    instance_ids: s.target.type === 'instances' ? s.target.instance_ids : [],
  }
}

/** Erros que impedem enviar o formulário. */
export function draftErrors(d: Draft): string[] {
  const errors: string[] = []
  const t = i18n.getFixedT(null, 'schedules')
  if (!d.project_id) errors.push(t('errors.project'))
  if (!d.name.trim()) errors.push(t('errors.name'))
  if (d.days.length === 0) errors.push(t('errors.days'))
  if (d.windows.length === 0) errors.push(t('errors.windows'))
  d.windows.forEach((w, i) => {
    if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) errors.push(t('errors.incomplete', { n: i + 1 }))
    else if (w.start === w.end) errors.push(t('errors.same', { n: i + 1 }))
  })
  if (d.targetType === 'instances' && d.instance_ids.length === 0) errors.push(t('errors.instances'))
  return errors
}

function toInput(d: Draft): ScheduleInput {
  return {
    project_id: d.project_id,
    name: d.name.trim(),
    timezone: d.timezone.trim(),
    days: [...d.days].sort((a, b) => a - b),
    windows: d.windows,
    target:
      d.targetType === 'project'
        ? { type: 'project', environment_id: d.environment_id || null }
        : { type: 'instances', instance_ids: d.instance_ids },
  }
}

export function ScheduleEditor({
  view,
  projects,
  defaultTimezone,
  onSaved,
  onClose,
}: {
  view: ScheduleView | null
  projects: Project[]
  defaultTimezone: string
  onSaved: (saved: ScheduleView) => void
  onClose: () => void
}) {
  const { t } = useTranslation('schedules')
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view, defaultTimezone, projects[0]?.id ?? ''))
  const [touched, setTouched] = useState(false)
  const errors = draftErrors(draft)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  const environments = useQuery({
    queryKey: ['environments', draft.project_id],
    queryFn: () => api.environments(draft.project_id),
    enabled: Boolean(draft.project_id),
  })
  const instances = useQuery({
    queryKey: ['instances', draft.project_id],
    queryFn: () => api.instances(draft.project_id),
    enabled: Boolean(draft.project_id),
  })

  const save = useFeedbackMutation({
    mutationFn: (input: ScheduleInput) =>
      view ? api.updateSchedule(view.schedule.id, input) : api.createSchedule(input),
    success: view ? t('editor.updated') : t('editor.created'),
    invalidate: [[]],
    onSuccess: (saved) => onSaved(saved),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (errors.length > 0) return
    save.mutate(toInput(draft))
  }

  const conflicts =
    save.error instanceof ApiError && Array.isArray(save.error.details?.conflicts)
      ? (save.error.details.conflicts as number[])
      : []

  const toggleDay = (day: number) =>
    set({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] })
  const setWindow = (i: number, patch: Partial<ScheduleWindow>) =>
    set({ windows: draft.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) })
  const toggleInstance = (id: string) =>
    set({
      instance_ids: draft.instance_ids.includes(id)
        ? draft.instance_ids.filter((x) => x !== id)
        : [...draft.instance_ids, id],
    })

  return (
    <Modal
      title={view ? t('editor.titleEdit') : t('editor.titleNew')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('ui.cancel', { ns: 'common' })}</Button>
          <Button variant="primary" type="submit" form="schedule-form" loading={save.isPending}>
            {view ? t('editor.save') : t('editor.create')}
          </Button>
        </>
      }
    >
      <form id="schedule-form" className="stack" onSubmit={submit} aria-label={t('editor.label')}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="schedule-name">{t('editor.name')}</label>
            <Input
              id="schedule-name"
              value={draft.name}
              placeholder={t('editor.namePlaceholder')}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="schedule-project">{t('editor.project')}</label>
            <Select
              id="schedule-project"
              value={draft.project_id}
              disabled={Boolean(view)}
              onChange={(e) => set({ project_id: e.target.value, environment_id: '', instance_ids: [] })}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name ?? p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label htmlFor="schedule-timezone">{t('editor.timezone')}</label>
            <Input
              id="schedule-timezone"
              list="timezones"
              value={draft.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
            />
            <datalist id="timezones">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="field">
          <span className="section-title">{t('editor.target')}</span>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                name="target"
                checked={draft.targetType === 'project'}
                onChange={() => set({ targetType: 'project' })}
              />{' '}
              {t('editor.wholeProject')}
            </label>
            <label>
              <input
                type="radio"
                name="target"
                checked={draft.targetType === 'instances'}
                onChange={() => set({ targetType: 'instances' })}
              />{' '}
              {t('editor.selectedServices')}
            </label>
          </div>
        </div>
        {draft.targetType === 'project' ? (
          <div className="field">
            <label htmlFor="schedule-environment">{t('editor.environment')}</label>
            <Select
              id="schedule-environment"
              value={draft.environment_id}
              onChange={(e) => set({ environment_id: e.target.value })}
            >
              <option value="">{t('editor.allEnvs')}</option>
              {environments.data?.environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </Select>
            <span className="hint">{t('editor.envHint')}</span>
          </div>
        ) : (
          <ul className="check-list" aria-label={t('editor.services')}>
            {instances.data?.instances.map((v) => (
              <li key={v.instance.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.instance_ids.includes(v.instance.id)}
                    onChange={() => toggleInstance(v.instance.id)}
                  />
                  <span>{v.service.name}</span>
                  <span className="subtle">{v.environment.name}</span>
                </label>
              </li>
            ))}
            {instances.data?.instances.length === 0 && <li className="subtle">{t('editor.noServices')}</li>}
          </ul>
        )}

        <div className="field">
          <span className="section-title">{t('editor.daysTitle')}</span>
          <div className="row" role="group" aria-label={t('editor.weekdays')}>
            {DAY_LABEL.map((label, day) => (
              <Button
                key={day}
                variant={draft.days.includes(day) ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={draft.days.includes(day)}
                onClick={() => toggleDay(day)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="section-title">{t('editor.onTimes')}</span>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {draft.windows.map((w, i) => (
              <div className="row" key={i} data-testid="window-row">
                <span className="subtle" style={{ width: 64 }}>
                  {t('editor.window', { n: i + 1 })}
                </span>
                <Input
                  type="time"
                  style={{ width: 130 }}
                  aria-label={t('editor.startOf', { n: i + 1 })}
                  aria-invalid={conflicts.includes(i + 1)}
                  value={w.start}
                  onChange={(e) => setWindow(i, { start: e.target.value })}
                />
                <span className="subtle">{t('editor.until')}</span>
                <Input
                  type="time"
                  style={{ width: 130 }}
                  aria-label={t('editor.endOf', { n: i + 1 })}
                  aria-invalid={conflicts.includes(i + 1)}
                  value={w.end}
                  onChange={(e) => setWindow(i, { end: e.target.value })}
                />
                {w.end < w.start && <span className="subtle">{t('editor.nextDay')}</span>}
                <Button variant="ghost" size="sm"
                  aria-label={t('editor.removeWindow', { n: i + 1 })}
                  onClick={() => set({ windows: draft.windows.filter((_, j) => j !== i) })}
                >
                  {t('editor.remove')}
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm"
                onClick={() => set({ windows: [...draft.windows, { start: '13:00', end: '18:00' }] })}
              >
                {t('editor.addWindow')}
              </Button>
            </div>
          </div>
          <span className="hint">{t('editor.windowHint')}</span>
        </div>

        {touched && errors.length > 0 && (
          <div className="alert alert-danger" role="alert">
            <span>{errors.join(' ')}</span>
          </div>
        )}
        <ErrorState error={save.error} />
      </form>
    </Modal>
  )
}

// ---------- detalhe ----------

export function ScheduleDetail({ view, onClose }: { view: ScheduleView; onClose: () => void }) {
  const { t } = useTranslation('schedules')
  const runs = useQuery({ queryKey: ['schedule-runs', view.schedule.id], queryFn: () => api.scheduleRuns(view.schedule.id) })
  const [operation, setOperation] = useState<string | null>(null)
  const tz = view.schedule.timezone
  if (operation) return <OperationResult operationId={operation} onClose={() => setOperation(null)} />
  return (
    <Modal
      title={view.schedule.name}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('ui.close', { ns: 'common' })}</Button>}
    >
      <p className="muted">
        {formatDays(view.schedule.days)} · {windowsLabel(view.schedule.windows)} · {tz}
      </p>
      <div>
        <div className="group-title">{t('detail.next')}</div>
        {view.next_runs.length === 0 ? (
          <p className="subtle">{t('detail.pausedNone')}</p>
        ) : (
          <ul className="check-list">
            {view.next_runs.map((o) => (
              <li key={o.at + o.action} data-testid="next-run">
                <span>{KIND_LABEL[o.action]}</span>
                <span className="spacer" />
                <span className="mono">{formatInZone(o.at, tz)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="group-title">{t('detail.last')}</div>
        <ErrorState error={runs.error} />
        {runs.data && runs.data.items.length === 0 && <p className="subtle">{t('detail.noRuns')}</p>}
        {runs.data && runs.data.items.length > 0 && (
          <div className="card">
            <Table label={t('detail.table')}>
              <thead>
                <tr>
                  <th>{t('detail.time')}</th>
                  <th>{t('detail.action')}</th>
                  <th>{t('detail.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((r) => (
                  <tr key={r.id} data-testid="run-row">
                    <td className="mono">{formatInZone(r.scheduled_for, tz)}</td>
                    <td>{KIND_LABEL[r.action]}</td>
                    <td>
                      <span className={`result result-run-${r.status}`}>{RUN_LABEL[r.status]}</span>
                      {r.message && <div className="subtle">{r.message}</div>}
                    </td>
                    <td className="num">
                      {r.operation_id && (
                        <Button size="sm" onClick={() => setOperation(r.operation_id)}>
                          {t('detail.viewOperation')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------- ações agendadas pontuais ----------

/** Ações pendentes criadas pelo console (`stop all --at 18:00`), com cancelamento. */
export function PendingActions() {
  const { t } = useTranslation('schedules')
  const canCancel = useSession().can('operator')
  const actions = useQuery({
    queryKey: ['scheduled-actions', 'pending'],
    queryFn: () => api.scheduledActions('pending'),
    refetchInterval: 60_000,
  })
  const cancel = useFeedbackMutation({
    mutationFn: (id: string) => api.cancelScheduledAction(id),
    success: t('pending.cancelled'),
    invalidate: [['scheduled-actions']],
  })
  const items = actions.data?.items ?? []
  if (!actions.data && !actions.error) return <Skeleton lines={3} label={t('pending.loading')} />
  return (
    <section aria-label={t('pending.label')} className="stack">
      <p className="subtle">
        <Trans t={t} i18nKey="pending.hint" components={{ 1: <code /> }} />
      </p>
      <ErrorState error={actions.error ?? cancel.error} />
      {items.length === 0 ? (
        <div className="card">
          <EmptyState title={t('pending.none')} />
        </div>
      ) : (
        <div className="card">
          <Table label={t('pending.label')}>
            <thead>
              <tr>
                <th>{t('pending.action')}</th>
                <th>{t('pending.target')}</th>
                <th>{t('pending.when')}</th>
                <th>{t('pending.note')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} data-testid="pending-action">
                  <td>{KIND_LABEL[a.kind]}</td>
                  <td>{a.label}</td>
                  <td className="mono">{formatInZone(a.run_at, actions.data!.default_timezone)}</td>
                  <td>{a.note ?? ''}</td>
                  <td className="num">
                    {canCancel && (
                      <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(a.id)}>
                        {t('pending.cancel')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  )
}

// ---------- lista ----------

export function Schedules() {
  const { t } = useTranslation('schedules')
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api.schedules() })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null)
  const [detail, setDetail] = useState<ScheduleView | null>(null)
  const [removing, setRemoving] = useState<ScheduleView | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [params, setParams] = useSearchParams()
  const tab = params.get('aba') === 'acoes' ? 'actions' : 'schedules'
  const pending = useQuery({
    queryKey: ['scheduled-actions', 'pending'],
    queryFn: () => api.scheduledActions('pending'),
    refetchInterval: 60_000,
  })

  const session = useSession()
  const canOperate = session.can('operator')
  const canManage = session.can('admin')
  const toggle = useFeedbackMutation({
    mutationFn: (view: ScheduleView) =>
      view.schedule.enabled ? api.pauseSchedule(view.schedule.id) : api.resumeSchedule(view.schedule.id),
    success: (_, view) => (view.schedule.enabled ? t('pausedDone') : t('resumedDone')),
    invalidate: [['schedules']],
  })
  const remove = useFeedbackMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    success: t('deleted'),
    invalidate: [[]],
    onSuccess: () => setRemoving(null),
  })

  const list = schedules.data?.schedules ?? []
  const projectList = useMemo(() => projects.data?.projects ?? [], [projects.data])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('subtitle')}</p>
        </div>
        {tab === 'schedules' && canManage && (
          <Button variant="primary" disabled={projectList.length === 0} onClick={() => setEditing('new')}>
            {t('new')}
          </Button>
        )}
      </div>

      <Tabs
        label={t('sections')}
        value={tab}
        onChange={(id) => setParams(id === 'actions' ? { aba: 'acoes' } : {}, { replace: true })}
        items={[
          { id: 'schedules', label: t('tabSchedules'), count: schedules.data?.schedules.length },
          { id: 'actions', label: t('tabActions'), count: pending.data?.items.length },
        ]}
      />
      <div style={{ marginTop: 'var(--space-4)' }}>
        {tab === 'actions' && <PendingActions />}
      </div>


      {tab === 'schedules' && (
      <div className="stack">
        <ErrorState error={schedules.error ?? toggle.error} />
        {warnings.length > 0 && (
          <div className="alert alert-warn" role="status">
            <span>
              {t('warnings', { warnings: warnings.join(' ') })}
              <Button variant="ghost" size="sm" onClick={() => setWarnings([])}>
                {t('dismiss')}
              </Button>
            </span>
          </div>
        )}

        {schedules.isPending && (
          <div className="card">
            <Skeleton lines={4} label={t('loading')} />
          </div>
        )}
        {schedules.data && list.length === 0 && (
          <div className="card">
            <EmptyState
              title={t('emptyTitle')}
              action={
                canManage ? (
                  <Button variant="primary" disabled={projectList.length === 0} onClick={() => setEditing('new')}>
                    {t('new')}
                  </Button>
                ) : undefined
              }
            >
              {canManage ? t('emptyAdmin') : t('emptyViewer')}
            </EmptyState>
          </div>
        )}

        {list.length > 0 && (
          <div className="card">
            <Table label={t('table')}>
              <thead>
                <tr>
                  <th>{t('schedule')}</th>
                  <th>{t('project')}</th>
                  <th>{t('days')}</th>
                  <th>{t('windows')}</th>
                  <th>{t('nextRun')}</th>
                  <th>{t('status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((view) => {
                  const s = view.schedule
                  const next = view.next_runs[0]
                  return (
                    <tr key={s.id} data-testid="schedule-row">
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Button variant="ghost" size="sm" style={{ whiteSpace: 'nowrap' }} onClick={() => setDetail(view)}>
                          {s.name}
                        </Button>
                      </td>
                      <td>{projectName(projectList, s.project_id)}</td>
                      <td>{formatDays(s.days)}</td>
                      <td className="mono">{windowsLabel(s.windows)}</td>
                      <td>
                        {next ? (
                          <>
                            {KIND_LABEL[next.action]} · <span className="mono">{formatInZone(next.at, s.timezone)}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <span className={s.enabled ? 'result result-succeeded' : 'result result-skipped'}>
                          {s.enabled ? t('active') : t('paused')}
                        </span>
                        {s.paused_reason && <div className="subtle">{s.paused_reason}</div>}
                      </td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {canOperate && (
                            <Button size="sm" onClick={() => toggle.mutate(view)}>
                              {s.enabled ? t('pause') : t('resume')}
                            </Button>
                          )}
                          {canManage && (
                            <>
                              <Button size="sm" onClick={() => setEditing(view)}>
                                {t('edit')}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setRemoving(view)}>
                                {t('delete')}
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
        )}
        {list.length > 0 && (
          <p className="subtle">
            {t('note')}
          </p>
        )}
      </div>
      )}

      {editing && (
        <ScheduleEditor
          view={editing === 'new' ? null : editing}
          projects={projectList}
          defaultTimezone={schedules.data?.default_timezone ?? 'America/Sao_Paulo'}
          onSaved={(saved) => {
            setWarnings(saved.warnings)
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {detail && <ScheduleDetail view={detail} onClose={() => setDetail(null)} />}
      {removing && (
        <ConfirmDialog
          title={t('deleteTitle')}
          message={
            <p>
              <Trans t={t} i18nKey="deleteMessage" values={{ name: removing.schedule.name }} components={{ 1: <strong /> }} />
            </p>
          }
          confirmLabel={t('delete')}
          danger
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
          onConfirm={() => remove.mutate(removing.schedule.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}
