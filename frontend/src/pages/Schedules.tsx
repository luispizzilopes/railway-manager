import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useMemo, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Project, ScheduleInput, ScheduleView, ScheduleWindow } from '../api/types'
import { ConfirmDialog, ErrorAlert, Modal } from '../components/Modal'
import { OperationResult } from '../components/OperationFlow'
import { DAY_LABEL, KIND_LABEL, RUN_LABEL, formatDays, formatInZone } from '../format'

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

function targetLabel(view: ScheduleView): string {
  const t = view.schedule.target
  if (t.type === 'instances') return `${t.instance_ids.length} serviço(s) selecionado(s)`
  return t.environment_id ? 'Projeto inteiro (um ambiente)' : 'Projeto inteiro'
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
  if (!d.project_id) errors.push('Escolha o projeto.')
  if (!d.name.trim()) errors.push('Dê um nome à agenda.')
  if (d.days.length === 0) errors.push('Selecione ao menos um dia da semana.')
  if (d.windows.length === 0) errors.push('Adicione ao menos uma janela de horário.')
  d.windows.forEach((w, i) => {
    if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) errors.push(`Janela ${i + 1}: horário incompleto.`)
    else if (w.start === w.end) errors.push(`Janela ${i + 1}: início e fim iguais.`)
  })
  if (d.targetType === 'instances' && d.instance_ids.length === 0) errors.push('Selecione ao menos um serviço.')
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
  const queryClient = useQueryClient()
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

  const save = useMutation({
    mutationFn: (input: ScheduleInput) =>
      view ? api.updateSchedule(view.schedule.id, input) : api.createSchedule(input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries()
      onSaved(saved)
    },
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
      title={view ? 'Editar agenda' : 'Nova agenda'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="schedule-form" className="btn btn-primary" disabled={save.isPending}>
            {view ? 'Salvar' : 'Criar agenda'}
          </button>
        </>
      }
    >
      <form id="schedule-form" className="stack" onSubmit={submit} aria-label="Agenda">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="schedule-name">Nome</label>
            <input
              id="schedule-name"
              className="input"
              value={draft.name}
              placeholder="ex.: horário comercial"
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="schedule-project">Projeto</label>
            <select
              id="schedule-project"
              className="select"
              value={draft.project_id}
              disabled={Boolean(view)}
              onChange={(e) => set({ project_id: e.target.value, environment_id: '', instance_ids: [] })}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name ?? p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="schedule-timezone">Fuso horário</label>
            <input
              id="schedule-timezone"
              className="input"
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
          <span className="section-title">O que ligar e desligar</span>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                name="target"
                checked={draft.targetType === 'project'}
                onChange={() => set({ targetType: 'project' })}
              />{' '}
              Projeto inteiro
            </label>
            <label>
              <input
                type="radio"
                name="target"
                checked={draft.targetType === 'instances'}
                onChange={() => set({ targetType: 'instances' })}
              />{' '}
              Serviços selecionados
            </label>
          </div>
        </div>
        {draft.targetType === 'project' ? (
          <div className="field">
            <label htmlFor="schedule-environment">Ambiente</label>
            <select
              id="schedule-environment"
              className="select"
              value={draft.environment_id}
              onChange={(e) => set({ environment_id: e.target.value })}
            >
              <option value="">Todos os ambientes</option>
              {environments.data?.environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
            <span className="hint">Serviços importados depois entram automaticamente.</span>
          </div>
        ) : (
          <ul className="check-list" aria-label="Serviços">
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
            {instances.data?.instances.length === 0 && <li className="subtle">Nenhum serviço importado neste projeto.</li>}
          </ul>
        )}

        <div className="field">
          <span className="section-title">Dias</span>
          <div className="row" role="group" aria-label="Dias da semana">
            {DAY_LABEL.map((label, day) => (
              <button
                key={label}
                type="button"
                className={draft.days.includes(day) ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                aria-pressed={draft.days.includes(day)}
                onClick={() => toggleDay(day)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="section-title">Horários ligados</span>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {draft.windows.map((w, i) => (
              <div className="row" key={i} data-testid="window-row">
                <span className="subtle" style={{ width: 64 }}>
                  Janela {i + 1}
                </span>
                <input
                  type="time"
                  className="input"
                  style={{ width: 130 }}
                  aria-label={`Início da janela ${i + 1}`}
                  aria-invalid={conflicts.includes(i + 1)}
                  value={w.start}
                  onChange={(e) => setWindow(i, { start: e.target.value })}
                />
                <span className="subtle">até</span>
                <input
                  type="time"
                  className="input"
                  style={{ width: 130 }}
                  aria-label={`Fim da janela ${i + 1}`}
                  aria-invalid={conflicts.includes(i + 1)}
                  value={w.end}
                  onChange={(e) => setWindow(i, { end: e.target.value })}
                />
                {w.end < w.start && <span className="subtle">termina no dia seguinte</span>}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Remover janela ${i + 1}`}
                  onClick={() => set({ windows: draft.windows.filter((_, j) => j !== i) })}
                >
                  Remover
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => set({ windows: [...draft.windows, { start: '13:00', end: '18:00' }] })}
              >
                Adicionar janela
              </button>
            </div>
          </div>
          <span className="hint">Liga no início e desliga no fim de cada janela, nos dias marcados.</span>
        </div>

        {touched && errors.length > 0 && (
          <div className="alert alert-danger" role="alert">
            <span>{errors.join(' ')}</span>
          </div>
        )}
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  )
}

// ---------- detalhe ----------

export function ScheduleDetail({ view, onClose }: { view: ScheduleView; onClose: () => void }) {
  const runs = useQuery({ queryKey: ['schedule-runs', view.schedule.id], queryFn: () => api.scheduleRuns(view.schedule.id) })
  const [operation, setOperation] = useState<string | null>(null)
  const tz = view.schedule.timezone
  if (operation) return <OperationResult operationId={operation} onClose={() => setOperation(null)} />
  return (
    <Modal
      title={view.schedule.name}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <p className="muted">
        {formatDays(view.schedule.days)} · {windowsLabel(view.schedule.windows)} · {tz}
      </p>
      <div>
        <div className="group-title">Próximas execuções</div>
        {view.next_runs.length === 0 ? (
          <p className="subtle">Agenda pausada: nenhuma execução prevista.</p>
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
        <div className="group-title">Últimas execuções</div>
        <ErrorAlert error={runs.error} />
        {runs.data && runs.data.items.length === 0 && <p className="subtle">Nenhuma execução ainda.</p>}
        {runs.data && runs.data.items.length > 0 && (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Horário</th>
                  <th>Ação</th>
                  <th>Situação</th>
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
                        <button type="button" className="btn btn-sm" onClick={() => setOperation(r.operation_id)}>
                          Ver operação
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------- ações agendadas pontuais ----------

/** Ações pendentes criadas pelo console (`stop all --at 18:00`), com cancelamento. */
export function PendingActions() {
  const queryClient = useQueryClient()
  const actions = useQuery({
    queryKey: ['scheduled-actions', 'pending'],
    queryFn: () => api.scheduledActions('pending'),
    refetchInterval: 60_000,
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelScheduledAction(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['scheduled-actions'] }),
  })
  const items = actions.data?.items ?? []
  if (!actions.data && !actions.error) return null
  return (
    <section aria-labelledby="pending-actions" className="stack">
      <div>
        <h2 id="pending-actions">Ações agendadas</h2>
        <p className="subtle">
          Ações únicas criadas pelo console, por exemplo <code>stop all --at 18:00</code>. Veja{' '}
          <code>help stop</code> no console.
        </p>
      </div>
      <ErrorAlert error={actions.error ?? cancel.error} />
      {items.length === 0 ? (
        <div className="card empty">Nenhuma ação pendente.</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ação</th>
                <th>Alvo</th>
                <th>Quando</th>
                <th>Observação</th>
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
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(a.id)}
                    >
                      Cancelar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------- lista ----------

export function Schedules() {
  const queryClient = useQueryClient()
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api.schedules() })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null)
  const [detail, setDetail] = useState<ScheduleView | null>(null)
  const [removing, setRemoving] = useState<ScheduleView | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const toggle = useMutation({
    mutationFn: (view: ScheduleView) =>
      view.schedule.enabled ? api.pauseSchedule(view.schedule.id) : api.resumeSchedule(view.schedule.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      setRemoving(null)
      void queryClient.invalidateQueries()
    },
  })

  const list = schedules.data?.schedules ?? []
  const projectList = useMemo(() => projects.data?.projects ?? [], [projects.data])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agendas</h1>
          <p className="muted">Liga e desliga projetos ou serviços automaticamente nos horários definidos.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={projectList.length === 0}
          onClick={() => setEditing('new')}
        >
          Nova agenda
        </button>
      </div>

      <div className="stack">
        <ErrorAlert error={schedules.error ?? toggle.error} />
        {warnings.length > 0 && (
          <div className="alert alert-warn" role="status">
            <span>
              Agenda salva com avisos: {warnings.join(' ')}{' '}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWarnings([])}>
                Dispensar
              </button>
            </span>
          </div>
        )}

        {schedules.data && list.length === 0 && (
          <div className="card empty">
            <h3>Nenhuma agenda</h3>
            <p>Crie uma agenda para ligar e desligar serviços nos horários de uso.</p>
          </div>
        )}

        {list.length > 0 && (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agenda</th>
                  <th>Projeto</th>
                  <th>Dias</th>
                  <th>Horários ligados</th>
                  <th>Próxima execução</th>
                  <th>Situação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((view) => {
                  const s = view.schedule
                  const next = view.next_runs[0]
                  return (
                    <tr key={s.id} data-testid="schedule-row">
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetail(view)}>
                          {s.name}
                        </button>
                        <div className="subtle">{targetLabel(view)}</div>
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
                          {s.enabled ? 'Ativa' : 'Pausada'}
                        </span>
                        {s.paused_reason && <div className="subtle">{s.paused_reason}</div>}
                      </td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button type="button" className="btn btn-sm" onClick={() => toggle.mutate(view)}>
                            {s.enabled ? 'Pausar' : 'Retomar'}
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => setEditing(view)}>
                            Editar
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(view)}>
                            Excluir
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
        {list.length > 0 && (
          <p className="subtle">
            O agendador age só nos horários: ligar ou desligar manualmente vale até o próximo evento.
          </p>
        )}
        <PendingActions />
      </div>

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
          title="Excluir agenda"
          message={
            <p>
              Excluir <strong>{removing.schedule.name}</strong>? As operações já feitas por ela continuam no histórico.
            </p>
          }
          confirmLabel="Excluir"
          danger
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate(removing.schedule.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}
