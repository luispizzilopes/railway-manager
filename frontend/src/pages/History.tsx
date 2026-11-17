import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router'

import { api } from '../api/client'
import type { HistoryFilters, ItemResult } from '../api/types'
import { ErrorAlert } from '../components/Modal'
import { StateChip } from '../components/StateChip'
import { KIND_LABEL, RESULT_LABEL, formatDateTime, formatDuration } from '../format'

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
          <p className="muted">Cada instância de cada operação, da mais recente para a mais antiga.</p>
        </div>
      </div>

      <form className="card card-body" onSubmit={apply} aria-label="Filtros" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="f-project">Projeto</label>
            <select id="f-project" className="select" value={draft.project ?? ''} onChange={set('project')}>
              <option value="">Todos</option>
              {projects.data?.projects.map((p) => (
                <option key={p.id} value={p.railway_project_id}>
                  {p.display_name ?? p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-service">Railway Service ID</label>
            <input id="f-service" className="input mono" value={draft.service ?? ''} onChange={set('service')} />
          </div>
          <div className="field">
            <label htmlFor="f-environment">Ambiente</label>
            <input
              id="f-environment"
              className="input"
              placeholder="ex.: production"
              value={draft.environment ?? ''}
              onChange={set('environment')}
            />
          </div>
          <div className="field">
            <label htmlFor="f-kind">Tipo</label>
            <select id="f-kind" className="select" value={draft.kind ?? ''} onChange={set('kind')}>
              <option value="">Todos</option>
              <option value="stop">Desligar</option>
              <option value="start">Iniciar</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-result">Resultado</label>
            <select id="f-result" className="select" value={draft.result ?? ''} onChange={set('result')}>
              <option value="">Todos</option>
              {(Object.keys(RESULT_LABEL) as ItemResult[]).map((r) => (
                <option key={r} value={r}>
                  {RESULT_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-trigger">Origem</label>
            <select id="f-trigger" className="select" value={draft.trigger ?? ''} onChange={set('trigger')}>
              <option value="">Todas</option>
              <option value="manual">Manual</option>
              <option value="schedule">Agenda</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">De</label>
            <input id="f-from" className="input" type="date" value={draft.from ?? ''} onChange={set('from')} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Até</label>
            <input id="f-to" className="input" type="date" value={draft.to ?? ''} onChange={set('to')} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 'var(--space-3)' }}>
          <button type="submit" className="btn btn-primary">
            Filtrar
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft({})
              setParams(new URLSearchParams())
            }}
          >
            Limpar
          </button>
        </div>
      </form>

      <ErrorAlert error={history.error} />
      <div className="card">
        {history.data && history.data.items.length === 0 ? (
          <div className="empty">Nenhuma operação encontrada com esses filtros.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Tipo</th>
                  <th>Projeto · serviço · ambiente</th>
                  <th>Antes → depois</th>
                  <th>Resultado</th>
                  <th className="num">Duração</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.items.map(({ item, kind, created_at, trigger, schedule_name }) => (
                  <tr key={item.id} data-testid="history-row">
                    <td>{formatDateTime(created_at)}</td>
                    <td>
                      {KIND_LABEL[kind]}
                      <div className="subtle">{trigger === 'schedule' ? `agenda: ${schedule_name}` : 'manual'}</div>
                    </td>
                    <td>
                      {item.label.project_name} · {item.label.service_name} · {item.label.environment_name}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.data && history.data.total > 0 && (
          <div className="pagination">
            <span className="subtle">
              {history.data.total} registro(s) · página {page} de {pages}
            </span>
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                Anterior
              </button>
              <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                Próxima
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
