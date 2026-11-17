// Blocos de saída do console como componentes (tabelas reais, cópia de IDs, estados em texto).

import { useState } from 'react'

import type { OperationItem, Plan } from '../api/types'
import { StateChip } from '../components/StateChip'
import { KIND_LABEL, RESULT_LABEL, STATUS_LABEL, formatDuration } from '../format'
import type { Block, Cell } from './types'

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // sem área de transferência: o título ainda mostra o ID completo
    }
  }
  return (
    <button type="button" className="con-id" title={`${id} — clique para copiar`} onClick={copy}>
      {copied ? 'copiado' : id.slice(0, 8)}
    </button>
  )
}

function CellView({ cell }: { cell: Cell }) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'string' || typeof cell === 'number') return <>{cell}</>
  if ('state' in cell) return <StateChip state={cell.state} />
  if ('result' in cell) return <span className={`result result-${cell.result}`}>{RESULT_LABEL[cell.result]}</span>
  if ('id' in cell) return <CopyId id={cell.id} />
  return <span className={`con-tone-${cell.tone}`}>{cell.text}</span>
}

function Table({ title, columns, rows }: { title?: string; columns: string[]; rows: Cell[][] }) {
  return (
    <div className="con-block">
      {title && <div className="con-title">{title}</div>}
      <div className="con-table-wrap">
        <table className="con-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>
                    <CellView cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const ACTION: Record<'will_stop' | 'will_start' | 'will_skip', string> = {
  will_stop: 'desligar',
  will_start: 'iniciar',
  will_skip: 'ignorar',
}

function PlanBlock({ plan }: { plan: Plan }) {
  const counts = { will_stop: 0, will_start: 0, will_skip: 0 }
  for (const e of plan.entries) counts[e.action]++
  const total =
    [
      counts.will_stop && `${counts.will_stop} a desligar`,
      counts.will_start && `${counts.will_start} a iniciar`,
      counts.will_skip && `${counts.will_skip} ignorada(s)`,
    ]
      .filter(Boolean)
      .join(' · ') || 'nada'
  return (
    <div className="con-block" data-testid="con-plan">
      <Table
        title={`Plano — ${KIND_LABEL[plan.kind]}: ${total}`}
        columns={['Projeto', 'Serviço', 'Ambiente', 'Estado atual', 'Ação prevista']}
        rows={plan.entries.map((e) => [
          e.project_name,
          e.service_name,
          e.environment_name,
          { state: e.current_state },
          e.action === 'will_skip'
            ? { text: `${e.fails ? 'falhará' : 'ignorar'}: ${e.reason ?? ''}`, tone: e.fails ? 'error' : 'muted' }
            : { text: ACTION[e.action], tone: 'info' },
        ])}
      />
      <div className="con-muted">
        {plan.estimate.mutations} chamada(s) ao Railway · plano válido até{' '}
        {new Date(plan.expires_at).toLocaleTimeString('pt-BR')}
      </div>
    </div>
  )
}

function ProgressBlock({ block }: { block: Extract<Block, { kind: 'progress' }> }) {
  const items: OperationItem[] = block.items
  const status = block.status ? STATUS_LABEL[block.status] : 'iniciando…'
  return (
    <div className="con-block" data-testid="con-progress">
      <div className="con-title">
        Operação <CopyId id={block.operationId} /> — {KIND_LABEL[block.powerKind]} · {status}
        {!block.done && !block.detached && <span className="con-muted"> (acompanhando… Ctrl+C para soltar)</span>}
        {block.detached && !block.done && <span className="con-muted"> (continua no servidor)</span>}
      </div>
      {items.length > 0 && (
        <Table
          columns={['Projeto', 'Serviço', 'Ambiente', 'Resultado', 'Estado final', 'Duração']}
          rows={items.map((i) => [
            i.label.project_name,
            i.label.service_name,
            i.label.environment_name,
            i.error_message ? { text: `${RESULT_LABEL[i.result]}: ${i.error_message}`, tone: 'error' } : { result: i.result },
            i.final_state ? { state: i.final_state } : '—',
            formatDuration(i.duration_ms),
          ])}
        />
      )}
    </div>
  )
}

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'input':
      return (
        <div className="con-input-echo">
          <span className="con-prompt-sign" aria-hidden>
            ›
          </span>{' '}
          {block.text}
        </div>
      )
    case 'text':
      return <div className={`con-text${block.tone ? ` con-tone-${block.tone}` : ''}`}>{block.text}</div>
    case 'table':
      return <Table title={block.title} columns={block.columns} rows={block.rows} />
    case 'json':
      return <pre className="con-json">{JSON.stringify(block.value, null, 2)}</pre>
    case 'plan':
      return <PlanBlock plan={block.plan} />
    case 'progress':
      return <ProgressBlock block={block} />
    case 'error':
      return (
        <div className="con-text con-tone-error" role="alert">
          erro{block.status ? ` ${block.status}` : ''}: {block.message}
          {block.details !== undefined && block.details !== null && (
            <pre className="con-json">{JSON.stringify(block.details, null, 2)}</pre>
          )}
        </div>
      )
  }
}
