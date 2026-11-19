import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router'

import { api } from '@/shared/api/client'
import type { HistoryEntry, HistoryFilters, ItemResult } from '@/shared/api/types'
import { StateChip } from '@/shared/components/StateChip'
import { Button } from '@/shared/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback'
import { Field, Input, Select } from '@/shared/ui/Field'
import { Table } from '@/shared/ui/Table'
import { KIND_LABEL, RESULT_LABEL, formatDateTime, formatDuration, shortId } from '@/shared/lib/format'

const FILTER_KEYS = ['project', 'service', 'environment', 'kind', 'result', 'trigger', 'from', 'to'] as const
const PER_PAGE = 50

export function filtersFrom(params: URLSearchParams): HistoryFilters {
  const filters: HistoryFilters = {}
  for (const key of FILTER_KEYS) {
    const value = params.get(key)
    if (value) filters[key] = value
  }
  const page = Number(params.get('page'))
  if (page > 1) filters.page = page
  return filters
}

export function History() {
  const [params, setParams] = useSearchParams()
  const filters = filtersFrom(params)
  const [draft, setDraft] = useState<HistoryFilters>(filters)
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const history = useQuery({
    queryKey: ['history', filters],
    queryFn: () => api.history({ ...filters }),
    placeholderData: keepPreviousData,
  })

  function apply(e: FormEvent) {
    e.preventDefault()
    const next = new URLSearchParams()
    for (const key of FILTER_KEYS) {
      const value = draft[key]
      if (value) next.set(key, String(value))
    }
    setParams(next)
  }

  function goTo(page: number) {
    const next = new URLSearchParams(params)
    if (page > 1) next.set('page', String(page))
    else next.delete('page')
    setParams(next)
  }

  const set = (key: keyof HistoryFilters) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }))
  const page = history.data?.page ?? 1
  const pages = history.data ? Math.max(1, Math.ceil(history.data.total / (history.data.per_page || PER_PAGE))) : 1

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Histórico</h1>
          <p className="muted">Cada serviço de cada operação, da mais recente para a mais antiga.</p>
        </div>
      </div>

      <form className="card card-body" onSubmit={apply} aria-label="Filtros" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="form-grid">
          <Field label="Projeto">
            {(p) => (
              <Select {...p} value={draft.project ?? ''} onChange={set('project')}>
                <option value="">Todos</option>
                {projects.data?.projects.map((pr) => (
                  <option key={pr.id} value={pr.railway_project_id}>
                    {pr.display_name ?? pr.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Railway Service ID">
            {(p) => <Input {...p} className="mono" value={draft.service ?? ''} onChange={set('service')} />}
          </Field>
          <Field label="Ambiente">
            {(p) => <Input {...p} placeholder="ex.: production" value={draft.environment ?? ''} onChange={set('environment')} />}
          </Field>
          <Field label="Tipo">
            {(p) => (
              <Select {...p} value={draft.kind ?? ''} onChange={set('kind')}>
                <option value="">Todos</option>
                <option value="stop">Desligar</option>
                <option value="start">Iniciar</option>
              </Select>
            )}
          </Field>
          <Field label="Resultado">
            {(p) => (
              <Select {...p} value={draft.result ?? ''} onChange={set('result')}>
                <option value="">Todos</option>
                {(Object.keys(RESULT_LABEL) as ItemResult[]).map((r) => (
                  <option key={r} value={r}>
                    {RESULT_LABEL[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Origem">
            {(p) => (
              <Select {...p} value={draft.trigger ?? ''} onChange={set('trigger')}>
                <option value="">Todas</option>
                <option value="manual">Manual</option>
                <option value="schedule">Agenda</option>
                <option value="scheduled_action">Ação agendada</option>
              </Select>
            )}
          </Field>
          <Field label="De">{(p) => <Input {...p} type="date" value={draft.from ?? ''} onChange={set('from')} />}</Field>
          <Field label="Até">{(p) => <Input {...p} type="date" value={draft.to ?? ''} onChange={set('to')} />}</Field>
        </div>
        <div className="row" style={{ marginTop: 'var(--space-3)' }}>
          <Button type="submit" variant="primary">
            Filtrar
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({})
              setParams(new URLSearchParams())
            }}
          >
            Limpar
          </Button>
        </div>
      </form>

      <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />
      <div className="card">
        {history.isPending && <Skeleton lines={6} label="Carregando histórico…" />}
        {history.data && history.data.items.length === 0 ? (
          <EmptyState title="Nenhuma operação encontrada com esses filtros." />
        ) : (
          history.data && (
            <Table label="Histórico de operações">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Tipo</th>
                  <th>Projeto · serviço · ambiente</th>
                  <th>Antes → depois</th>
                  <th>Resultado</th>
                  <th className="num">Duração</th>
                  <th />
                </tr>
              </thead>
              {history.data.items.map((entry) => (
                <HistoryRow key={entry.item.id} entry={entry} />
              ))}
            </Table>
          )
        )}
        {history.data && history.data.total > 0 && (
          <div className="pagination">
            <span className="subtle">
              {history.data.total} registro(s) · página {page} de {pages}
            </span>
            <div className="row">
              <Button size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                Anterior
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** Linha do histórico; o detalhe (identificadores, horários, quem pediu) abre sob demanda. */
function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false)
  const { item, kind, created_at, trigger, schedule_name, scheduled_action_label, requested_by } = entry
  return (
    <tbody>
      <tr data-testid="history-row">
        <td className="when">{formatDateTime(created_at)}</td>
        <td>
          {KIND_LABEL[kind]}
          <div className="subtle">
            {trigger === 'schedule'
              ? `agenda: ${schedule_name}`
              : trigger === 'scheduled_action'
                ? `ação agendada: ${scheduled_action_label ?? ''}`
                : 'manual'}
          </div>
        </td>
        <td>
          {item.label.project_name} · <span className="mono">{item.label.service_name}</span> · {item.label.environment_name}
        </td>
        <td>
          <span className="row">
            <StateChip state={item.previous_state} /> →{' '}
            {item.final_state ? <StateChip state={item.final_state} /> : '—'}
          </span>
        </td>
        <td>
          <span className={`result result-${item.result}`}>{RESULT_LABEL[item.result]}</span>
          {item.error_message && <div className="subtle">{item.error_message}</div>}
        </td>
        <td className="num">{formatDuration(item.duration_ms)}</td>
        <td>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={`${open ? 'Ocultar' : 'Ver'} detalhes de ${item.label.service_name}`}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Ocultar' : 'Detalhes'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={7}>
            <dl className="detail-list">
              <div>
                <dt>Pedido por</dt>
                <dd>{requested_by}</dd>
              </div>
              <div>
                <dt>Operação</dt>
                <dd className="mono">{shortId(item.operation_id)}</dd>
              </div>
              <div>
                <dt>Deployment</dt>
                <dd className="mono">{item.deployment_id ? shortId(item.deployment_id) : '—'}</dd>
              </div>
              <div>
                <dt>Início</dt>
                <dd>{item.started_at ? formatDateTime(item.started_at) : '—'}</dd>
              </div>
              <div>
                <dt>Fim</dt>
                <dd>{item.finished_at ? formatDateTime(item.finished_at) : '—'}</dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </tbody>
  )
}
