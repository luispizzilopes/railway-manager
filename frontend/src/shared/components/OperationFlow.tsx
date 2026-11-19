// Fluxo de uma operação de energia: plano → confirmação → progresso por item → resumo.
// Nada é enviado ao backend para execução antes da confirmação explícita, exceto em
// ações individuais (`confirm = false`), que seguem o mesmo plano sem o passo extra.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { OperationItem, Plan, PlanEntry, PowerKind, PowerTarget } from '../api/types'
import { KIND_LABEL, RESULT_LABEL, STATUS_LABEL, formatDuration } from '../lib/format'
import { Modal } from './Modal'
import { StateChip } from './StateChip'
import { Button } from '../ui/Button'
import { ErrorState, Skeleton } from '../ui/Feedback'
import { Table } from '../ui/Table'

const ACTION_LABEL: Record<PlanEntry['action'], string> = {
  will_stop: 'Será desligada',
  will_start: 'Será iniciada',
  will_skip: 'Ignorada',
}

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>()
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item])
  return [...map.entries()]
}

function PlanView({ plan }: { plan: Plan }) {
  const actionable = plan.entries.filter((e) => e.action !== 'will_skip')
  const skipped = plan.entries.length - actionable.length
  return (
    <>
      <p>
        <strong>{actionable.length}</strong> {actionable.length === 1 ? 'serviço será afetado' : 'serviços serão afetados'}
        {skipped > 0 && <>, {skipped} ignorada{skipped > 1 ? 's' : ''}</>}.{' '}
        <span className="subtle">
          {plan.estimate.mutations} chamada(s) de {plan.kind === 'stop' ? 'desligamento' : 'início'} ao Railway; o plano
          expira às {new Date(plan.expires_at).toLocaleTimeString('pt-BR')}.
        </span>
      </p>
      {groupBy(plan.entries, (e) => e.project_name).map(([project, entries]) => (
        <div key={project}>
          <div className="group-title">{project}</div>
          <div className="card">
            <Table label={`Plano: ${project}`}>
              <thead>
                <tr>
                  <th>Serviço</th>
                  <th>Ambiente</th>
                  <th>Estado atual</th>
                  <th>Ação prevista</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.instance_id} data-testid="plan-entry">
                    <td>{e.service_name}</td>
                    <td>{e.environment_name}</td>
                    <td>
                      <StateChip state={e.current_state} />
                    </td>
                    <td>
                      {e.action === 'will_skip' ? (
                        <span className={e.fails ? 'result result-failed' : 'muted'}>
                          {e.fails ? 'Falhará' : ACTION_LABEL[e.action]}: {e.reason}
                        </span>
                      ) : (
                        <strong>
                          {ACTION_LABEL[e.action]}
                          {e.action === 'will_stop' && e.deployments > 1 && ` (${e.deployments} deployments)`}
                        </strong>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      ))}
    </>
  )
}

/** Andamento por serviço, em linha do tempo: cada item mostra resultado, estado final e duração. */
export function Progress({ items }: { items: OperationItem[] }) {
  return (
    <>
      {groupBy(items, (i) => i.label.project_name).map(([project, rows]) => (
        <div key={project}>
          <div className="group-title">{project}</div>
          <ol className="timeline" aria-label={`Andamento: ${project}`}>
            {rows.map((i) => (
              <li key={i.id} className={`timeline-item timeline-${i.result}`} data-testid="progress-item">
                <div className="timeline-head">
                  <span className="mono">{i.label.service_name}</span>
                  <span className="subtle">{i.label.environment_name}</span>
                  <span className="spacer" />
                  {i.final_state && <StateChip state={i.final_state} />}
                  <span className="subtle mono">{formatDuration(i.duration_ms)}</span>
                </div>
                <span className={`result result-${i.result}`}>{RESULT_LABEL[i.result]}</span>
                {i.error_message && <div className="subtle">{i.error_message}</div>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </>
  )
}

export function OperationFlow({
  kind,
  target,
  title,
  confirm = true,
  onClose,
}: {
  kind: PowerKind
  target: PowerTarget
  title: string
  /** Exige confirmação explícita do plano (obrigatório para mais de um serviço). */
  confirm?: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const requested = useRef(false)

  async function execute(p: Plan) {
    setBusy(true)
    setError(null)
    try {
      setOperationId((await api.execute(p.plan_id)).operation_id)
    } catch (err) {
      const existing = err instanceof ApiError ? err.details?.operation_id : undefined
      if (typeof existing === 'string') setOperationId(existing)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    api
      .plan(kind, target)
      .then((p) => {
        setPlan(p)
        const actionable = p.entries.some((e) => e.action !== 'will_skip')
        if (!confirm && actionable) void execute(p)
      })
      .catch(setError)
  }, [kind, target, confirm])

  const progress = useQuery({
    queryKey: ['operation', operationId],
    queryFn: () => api.operation(operationId!),
    enabled: operationId !== null,
    refetchInterval: (q) => (q.state.data?.done ? false : 2500),
  })

  const done = progress.data?.done ?? false
  useEffect(() => {
    if (done) void queryClient.invalidateQueries()
  }, [done, queryClient])

  const actionable = useMemo(() => plan?.entries.filter((e) => e.action !== 'will_skip').length ?? 0, [plan])

  let footer
  if (!operationId) {
    footer = (
      <>
        <Button onClick={onClose}>
          Cancelar
        </Button>
        {plan && confirm && (
          <Button
            variant={kind === 'stop' ? 'danger' : 'primary'}
            onClick={() => execute(plan)}
            loading={busy}
            disabled={actionable === 0}
          >
            Confirmar: {KIND_LABEL[kind].toLowerCase()} {actionable}
          </Button>
        )}
      </>
    )
  } else {
    footer = (
      <Button onClick={onClose}>
        {done ? 'Fechar' : 'Fechar (continua em segundo plano)'}
      </Button>
    )
  }

  const op = progress.data?.operation
  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      <ErrorState error={error} />
      {!plan && !error && <Skeleton lines={3} label="Lendo o estado atual no Railway…" />}
      {plan && !operationId && <PlanView plan={plan} />}
      {plan && !operationId && actionable === 0 && (
        <div className="alert alert-info">Nada a fazer: todos os serviços foram ignorados.</div>
      )}
      {operationId && (
        <>
          <div className="row">
            <strong>{op ? STATUS_LABEL[op.status] : 'Iniciando…'}</strong>
            {op && !done && <span className="subtle">atualiza a cada poucos segundos</span>}
          </div>
          {progress.data && <Progress items={progress.data.items} />}
        </>
      )}
    </Modal>
  )
}

/** Resultado de uma operação já criada (ex.: disparada por uma agenda). */
export function OperationResult({ operationId, onClose }: { operationId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['operation', operationId],
    queryFn: () => api.operation(operationId),
    refetchInterval: (q) => (q.state.data?.done ? false : 2500),
  })
  const op = detail.data?.operation
  return (
    <Modal
      title={op ? `${KIND_LABEL[op.kind]} — ${STATUS_LABEL[op.status]}` : 'Operação'}
      onClose={onClose}
      footer={
        <Button onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      {detail.data && <Progress items={detail.data.items} />}
    </Modal>
  )
}
