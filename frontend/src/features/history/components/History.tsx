import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import { api } from '@/shared/api/client'
import type { HistoryEntry, HistoryFilters, ItemResult } from '@/shared/api/types'
import { StateChip } from '@/shared/components/StateChip/StateChip'
import { Button } from '@/shared/ui/Button/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Field, Input, Select } from '@/shared/ui/Field/Field'
import { Table } from '@/shared/ui/Table/Table'
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
  const { t } = useTranslation('history')
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
          <h1>{t('title')}</h1>
          <p className="muted">{t('subtitle')}</p>
        </div>
      </div>

      <form className="card card-body" onSubmit={apply} aria-label={t('filters')} style={{ marginBottom: 'var(--space-4)' }}>
        <div className="form-grid">
          <Field label={t('project')}>
            {(p) => (
              <Select {...p} value={draft.project ?? ''} onChange={set('project')}>
                <option value="">{t('all')}</option>
                {projects.data?.projects.map((pr) => (
                  <option key={pr.id} value={pr.railway_project_id}>
                    {pr.display_name ?? pr.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('serviceId')}>
            {(p) => <Input {...p} className="mono" value={draft.service ?? ''} onChange={set('service')} />}
          </Field>
          <Field label={t('environment')}>
            {(p) => <Input {...p} placeholder={t('envPlaceholder')} value={draft.environment ?? ''} onChange={set('environment')} />}
          </Field>
          <Field label={t('kind')}>
            {(p) => (
              <Select {...p} value={draft.kind ?? ''} onChange={set('kind')}>
                <option value="">{t('all')}</option>
                <option value="stop">{KIND_LABEL.stop}</option>
                <option value="start">{KIND_LABEL.start}</option>
              </Select>
            )}
          </Field>
          <Field label={t('result')}>
            {(p) => (
              <Select {...p} value={draft.result ?? ''} onChange={set('result')}>
                <option value="">{t('all')}</option>
                {(Object.keys(RESULT_LABEL) as ItemResult[]).map((r) => (
                  <option key={r} value={r}>
                    {RESULT_LABEL[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('trigger')}>
            {(p) => (
              <Select {...p} value={draft.trigger ?? ''} onChange={set('trigger')}>
                <option value="">{t('allF')}</option>
                <option value="manual">{t('manual')}</option>
                <option value="schedule">{t('schedule')}</option>
                <option value="scheduled_action">{t('scheduledAction')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('from')}>{(p) => <Input {...p} type="date" value={draft.from ?? ''} onChange={set('from')} />}</Field>
          <Field label={t('to')}>{(p) => <Input {...p} type="date" value={draft.to ?? ''} onChange={set('to')} />}</Field>
        </div>
        <div className="row" style={{ marginTop: 'var(--space-3)' }}>
          <Button type="submit" variant="primary">
            {t('filter')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({})
              setParams(new URLSearchParams())
            }}
          >
            {t('clear')}
          </Button>
        </div>
      </form>

      <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />
      <div className="card">
        {history.isPending && <Skeleton lines={6} label={t('loading')} />}
        {history.data && history.data.items.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          history.data && (
            <Table label={t('table')}>
              <thead>
                <tr>
                  <th>{t('when')}</th>
                  <th>{t('kind')}</th>
                  <th>{t('what')}</th>
                  <th>{t('beforeAfter')}</th>
                  <th>{t('result')}</th>
                  <th className="num">{t('duration')}</th>
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
              {t('total', { count: history.data.total, page, pages })}
            </span>
            <div className="row">
              <Button size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                {t('prev')}
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                {t('next')}
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
  const { t } = useTranslation('history')
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
              ? t('triggerSchedule', { name: schedule_name })
              : trigger === 'scheduled_action'
                ? t('triggerAction', { label: scheduled_action_label ?? '' })
                : t('triggerManual')}
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
            aria-label={open ? t('hideDetails', { service: item.label.service_name }) : t('showDetails', { service: item.label.service_name })}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t('hide') : t('details')}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={7}>
            <dl className="detail-list">
              <div>
                <dt>{t('requestedBy')}</dt>
                <dd>{requested_by}</dd>
              </div>
              <div>
                <dt>{t('operation')}</dt>
                <dd className="mono">{shortId(item.operation_id)}</dd>
              </div>
              <div>
                <dt>{t('deployment')}</dt>
                <dd className="mono">{item.deployment_id ? shortId(item.deployment_id) : '—'}</dd>
              </div>
              <div>
                <dt>{t('started')}</dt>
                <dd>{item.started_at ? formatDateTime(item.started_at) : '—'}</dd>
              </div>
              <div>
                <dt>{t('finished')}</dt>
                <dd>{item.finished_at ? formatDateTime(item.finished_at) : '—'}</dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </tbody>
  )
}
