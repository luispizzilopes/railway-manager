import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { ApiError } from '../api/client'
import type { LogLine, LogSeverity } from '../api/types'
import { Button } from '../components/ui/Button'
import { Checkbox, Field, Input } from '../components/ui/Field'
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback'
import { useToast } from '../components/ui/Toast'
import { formatTime, stripAnsi, toText } from './utils'

export const SEVERITY_LABEL: Record<LogSeverity, string> = {
  error: 'ERRO',
  warn: 'AVISO',
  info: 'INFO',
  debug: 'DEBUG',
}

/** Linhas maiores que isto aparecem cortadas, com "ver mais". */
const LONG_LINE = 2000
const AT_END_PX = 24

const CREDENTIAL_CODES = new Set(['integration_not_configured', 'credential_invalid', 'credential_undecipherable'])

/** Trechos da mensagem, marcando as ocorrências da busca (sem HTML: tudo vira nó de texto). */
export function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase()
  if (!needle) return text
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  if (from === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function countMatches(lines: LogLine[], query: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  let total = 0
  for (const line of lines) {
    const text = stripAnsi(line.message).toLowerCase()
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) total += 1
  }
  return total
}

function Row({ line, query }: { line: LogLine; query: string }) {
  const [expanded, setExpanded] = useState(false)
  const message = stripAnsi(line.message)
  const long = message.length > LONG_LINE
  const shown = long && !expanded ? message.slice(0, LONG_LINE) : message
  return (
    <li className={`log-row${line.severity ? ` log-${line.severity}` : ''}`}>
      <time className="log-time" dateTime={line.timestamp} title={line.timestamp}>
        {formatTime(line.timestamp)}
      </time>
      <span className="log-sev">{line.severity ? SEVERITY_LABEL[line.severity] : '—'}</span>
      <span className="log-msg">
        {highlight(shown, query)}
        {long && (
          <button type="button" className="log-more" onClick={() => setExpanded(!expanded)}>
            {expanded ? ' ver menos' : '… ver mais'}
          </button>
        )}
      </span>
    </li>
  )
}

/** Mensagem do estado de erro, separando credencial, indisponibilidade e falha genérica. */
function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && CREDENTIAL_CODES.has(error.code)) {
    return (
      <div className="alert alert-danger" role="alert">
        <span className="alert-text">A credencial do Railway foi recusada ou não está configurada. {error.message}</span>
        <Link className="btn btn-sm" to="/settings">
          Ir para Configurações
        </Link>
      </div>
    )
  }
  if (error instanceof ApiError && (error.code === 'railway_unavailable' || error.status === 503)) {
    return <ErrorState error={new Error('O Railway está indisponível no momento. Tente novamente em instantes.')} onRetry={onRetry} />
  }
  return <ErrorState error={error} onRetry={onRetry} />
}

export interface LogViewerProps {
  lines: LogLine[]
  loading?: boolean
  error?: unknown
  /** Falha ao acompanhar: as linhas continuam na tela. */
  notice?: string | null
  truncated?: boolean
  /** A instância nunca teve deploy. */
  noDeployment?: boolean
  /** Nome do arquivo baixado, sem extensão. */
  fileName?: string
  onRetry?: () => void
  /** Controles extras da barra (por exemplo, pausar o acompanhamento). */
  toolbar?: ReactNode
}

export function LogViewer({ lines, loading, error, notice, truncated, noDeployment, fileName = 'logs', onRetry, toolbar }: LogViewerProps) {
  const toast = useToast()
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [atEnd, setAtEnd] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const matches = useMemo(() => countMatches(lines, query), [lines, query])

  // Segue o fim da lista só se a pessoa já estava no fim (rolar para cima congela a vista).
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  useEffect(() => {
    stick.current = true
    setAtEnd(true)
  }, [noDeployment, loading])

  function onScroll() {
    const el = box.current
    if (!el) return
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX
    stick.current = end
    setAtEnd(end)
  }

  function goToEnd() {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setAtEnd(true)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(toText(lines))
      toast.success(`${lines.length} linhas copiadas.`)
    } catch {
      toast.error('Não foi possível copiar. Use o download.')
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([toText(lines)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${fileName}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  let body: ReactNode
  if (error && lines.length === 0) {
    body = <Failure error={error} onRetry={onRetry} />
  } else if (loading && lines.length === 0) {
    body = <Skeleton lines={6} label="Carregando logs…" />
  } else if (noDeployment) {
    body = <EmptyState title="Nenhum deploy ainda">Este serviço ainda não teve deploy neste ambiente, então não há logs.</EmptyState>
  } else if (lines.length === 0) {
    body = <EmptyState title="Nenhum log no período">Amplie o intervalo, retire filtros ou escolha outro deploy.</EmptyState>
  } else {
    body = (
      <div className="log-box" ref={box} onScroll={onScroll} role="log" aria-label="Logs do serviço" tabIndex={0}>
        <ol className={`log-list${wrap ? ' log-wrap' : ''}`}>
          {lines.map((line, i) => (
            <Row key={`${line.timestamp}-${i}`} line={line} query={query} />
          ))}
        </ol>
      </div>
    )
  }

  return (
    <div className="logviewer">
      <div className="log-toolbar">
        <Field label="Buscar nos logs exibidos" className="log-search">
          {(p) => <Input {...p} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Texto" />}
        </Field>
        <div className="log-actions">
          <Checkbox label="Quebrar linhas" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          {toolbar}
          <Button size="sm" onClick={() => void copy()} disabled={lines.length === 0}>
            Copiar
          </Button>
          <Button size="sm" onClick={download} disabled={lines.length === 0}>
            Baixar
          </Button>
        </div>
      </div>
      <p className="log-meta subtle" aria-live="polite">
        {lines.length} {lines.length === 1 ? 'linha' : 'linhas'}
        {query.trim() && ` · ${matches} ${matches === 1 ? 'ocorrência' : 'ocorrências'}`}
        {truncated && ' · há mais linhas: só as mais recentes foram carregadas'}
      </p>
      {notice && (
        <div className="alert alert-warn" role="status">
          <span className="alert-text">{notice}</span>
        </div>
      )}
      {body}
      {!atEnd && lines.length > 0 && (
        <Button size="sm" className="log-jump" onClick={goToEnd}>
          Ir para o fim
        </Button>
      )}
    </div>
  )
}
