import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/shared/api/client'
import { Button } from '@/shared/ui/Button/Button'
import { Checkbox, Field, Input, Select } from '@/shared/ui/Field/Field'
import { formatDateTime, shortId } from '@/shared/lib/format'
import { type LogFilterState, LIMITS, SEVERITIES, toApiFilters } from '@/features/logs/lib/filters'
import { LogViewer, severityLabel } from './LogViewer'
import { useLogs } from '@/features/logs/hooks/useLogs'

const LOG_TYPES = ['runtime', 'build'] as const

export interface LogsPanelProps {
  instanceId: string
  filters: LogFilterState
  onChange: (next: LogFilterState) => void
  /** Nome do arquivo baixado, sem extensão. */
  fileName: string
  /** Conteúdo à direita do título (links, botão de fechar). */
  actions?: ReactNode
  title?: ReactNode
}

/** Filtros, deploy, acompanhamento ao vivo e lista de logs de uma instância. */
export function LogsPanel({ instanceId, filters, onChange, fileName, actions, title }: LogsPanelProps) {
  const { t } = useTranslation('logs')
  const deployments = useQuery({
    queryKey: ['instance-deployments', instanceId],
    queryFn: () => api.instanceDeployments(instanceId),
  })
  const list = deployments.data?.deployments ?? []
  const currentId = list.find((d) => d.is_current)?.id
  const viewingOld = Boolean(filters.deployment) && filters.deployment !== currentId
  // Build, deploy antigo e intervalo fechado não têm o que acompanhar.
  const live = filters.type === 'runtime' && !viewingOld && !filters.end
  const logs = useLogs({ instanceId, filters: toApiFilters(filters), live })

  // O texto só vai ao Railway ao confirmar (Enter ou sair do campo), não a cada tecla.
  const [text, setText] = useState(filters.q)
  useEffect(() => setText(filters.q), [filters.q])
  const commitText = () => {
    if (text !== filters.q) onChange({ ...filters, q: text })
  }
  const set = (patch: Partial<LogFilterState>) => onChange({ ...filters, ...patch })

  function toggleSeverity(level: (typeof SEVERITIES)[number], on: boolean) {
    set({ severity: on ? [...filters.severity, level] : filters.severity.filter((s) => s !== level) })
  }

  const noDeployment = logs.deployment !== null && logs.deployment.id === null
  return (
    <section className="log-panel" aria-label={t('title')}>
      <div className="log-panel-head">
        <h2>{title ?? t('title')}</h2>
        <div className="row">{actions}</div>
      </div>

      <form
        className="log-filters"
        aria-label={t('panel.filters')}
        onSubmit={(e) => {
          e.preventDefault()
          commitText()
        }}
      >
        <Field label={t('panel.type')}>
          {(p) => (
            <Select {...p} value={filters.type} onChange={(e) => set({ type: e.target.value as LogFilterState['type'], deployment: '' })}>
              {LOG_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`panel.${type}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('panel.deploy')}>
          {(p) => (
            <Select {...p} value={filters.deployment} onChange={(e) => set({ deployment: e.target.value })}>
              <option value="">{t('panel.current')}</option>
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.status} · {d.created_at ? formatDateTime(d.created_at) : t('panel.noDate')} · {shortId(d.id)}
                  {d.is_current ? t('panel.currentTag') : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('panel.from')}>
          {(p) => <Input {...p} type="datetime-local" value={filters.start} onChange={(e) => set({ start: e.target.value })} />}
        </Field>
        <Field label={t('panel.to')} hint={filters.end ? t('panel.toHint') : undefined}>
          {(p) => <Input {...p} type="datetime-local" value={filters.end} onChange={(e) => set({ end: e.target.value })} />}
        </Field>
        <Field label={t('panel.lines')}>
          {(p) => (
            <Select {...p} value={filters.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="log-severities">
          <legend>{t('panel.severity')}</legend>
          {SEVERITIES.map((level) => (
            <Checkbox
              key={level}
              label={severityLabel(level)}
              checked={filters.severity.includes(level)}
              onChange={(e) => toggleSeverity(level, e.target.checked)}
            />
          ))}
        </fieldset>
        <Field label={t('panel.filterText')} hint={t('panel.filterTextHint')} className="log-filter-text">
          {(p) => (
            <Input
              {...p}
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                // O formulário tem vários campos e nenhum botão de envio: o Enter é tratado aqui.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitText()
                }
              }}
              placeholder={t('panel.filterPlaceholder')}
            />
          )}
        </Field>
      </form>

      {logs.deployment && logs.deployment.id && !logs.deployment.isCurrent && (
        <div className="alert alert-info" role="status">
          <span className="alert-text">
            {t('panel.oldDeploy', { status: logs.deployment.status ?? t('panel.noStatus') })}
          </span>
        </div>
      )}

      <LogViewer
        lines={logs.lines}
        loading={logs.loading}
        error={logs.error}
        notice={logs.notice}
        truncated={logs.truncated}
        noDeployment={noDeployment}
        fileName={fileName}
        onRetry={logs.reload}
        toolbar={
          <>
            {live && (
              <Button size="sm" onClick={() => logs.setPaused(!logs.paused)} aria-pressed={logs.paused}>
                {logs.paused ? t('panel.resume') : t('panel.pause')}
              </Button>
            )}
            <Button size="sm" onClick={logs.reload} loading={logs.loading}>
              {t('panel.refresh')}
            </Button>
          </>
        }
      />
      {live && !logs.paused && !noDeployment && (
        <p className="subtle" role="status">
          {t('panel.live')}
        </p>
      )}
      {live && logs.paused && (
        <p className="subtle" role="status">
          {t('panel.paused')}
        </p>
      )}
    </section>
  )
}
