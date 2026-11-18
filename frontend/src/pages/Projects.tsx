import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import { api, isUuid } from '../api/client'
import type { ProjectImportReport } from '../api/types'
import { Modal } from '../components/Modal'
import { Button } from '../components/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback'
import { Field, Input } from '../components/ui/Field'
import { Table } from '../components/ui/Table'
import { useFeedbackMutation } from '../components/useFeedbackMutation'
import { SYNC_LABEL, relativeTime } from '../format'

/** Cadastro manual por Railway Project ID. */
export function RegisterProjectForm({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const invalid = id.trim() !== '' && !isUuid(id)
  const create = useFeedbackMutation({
    mutationFn: () => api.createProject(id.trim(), name.trim() || undefined),
    success: 'Projeto cadastrado.',
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
    <form className="stack" onSubmit={submit} aria-label="Cadastrar projeto">
      <Field
        label="Railway Project ID"
        error={touched && (invalid || !id.trim()) ? 'Informe o ID do projeto (UUID), como aparece nas configurações do projeto.' : undefined}
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
      <Field label="Nome de exibição (opcional)" hint="O nome e a descrição vêm do Railway; este nome só muda aqui.">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <ErrorState error={create.error} />
      <div className="row">
        <Button variant="primary" type="submit" loading={create.isPending}>
          {create.isPending ? 'Validando no Railway…' : 'Cadastrar'}
        </Button>
      </div>
    </form>
  )
}

function DiscoverProjects({ onClose }: { onClose: () => void }) {
  const discovery = useQuery({ queryKey: ['discover-projects'], queryFn: api.discoverProjects })
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<ProjectImportReport | null>(null)
  const importMany = useFeedbackMutation({
    mutationFn: () => api.importProjects(selected),
    success: (r) => `${r.imported.length} projeto(s) importado(s).`,
    invalidate: [[]],
    onSuccess: (r) => {
      setReport(r)
      setSelected([])
    },
  })
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Modal
      title="Importar projetos do Railway"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" disabled={selected.length === 0} loading={importMany.isPending} onClick={() => importMany.mutate()}>
            Importar {selected.length || ''}
          </Button>
        </>
      }
    >
      <ErrorState error={discovery.error} onRetry={() => void discovery.refetch()} />
      {report && (
        <div className="alert alert-success" role="status">
          {report.imported.length} importado(s)
          {report.already_managed.length > 0 && `, ${report.already_managed.length} já gerenciado(s)`}
          {report.failed.length > 0 && `, ${report.failed.length} com falha: ${report.failed.map((f) => f.reason).join('; ')}`}.
        </div>
      )}
      {discovery.isPending && <Skeleton lines={4} label="Consultando o Railway…" />}
      {discovery.data?.workspaces.map((group) => (
        <div key={group.workspace?.id ?? 'sem-workspace'}>
          <div className="group-title">{group.workspace?.name ?? 'Sem workspace'}</div>
          {group.projects.length === 0 ? (
            <p className="subtle">Nenhum projeto neste workspace.</p>
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
                  {managed && <span className="subtle">já gerenciado</span>}
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
          <h1>Projetos</h1>
          <p className="muted">Projetos do Railway sob gerenciamento. Nada aqui cria ou exclui projetos no Railway.</p>
        </div>
        <div className="row">
          <Button onClick={() => setMode('manual')}>Cadastrar por ID</Button>
          <Button variant="primary" onClick={() => setMode('discover')}>
            Importar da conta
          </Button>
        </div>
      </div>
      <ErrorState error={projects.error} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />
      {projects.isPending && (
        <div className="card">
          <Skeleton lines={4} label="Carregando projetos…" />
        </div>
      )}
      {projects.data && all.length === 0 && (
        <div className="card">
          <EmptyState
            title="Nenhum projeto ainda"
            action={
              <Button variant="primary" onClick={() => setMode('discover')}>
                Importar da conta
              </Button>
            }
          >
            Importe a partir da conta ou cadastre pelo Railway Project ID.
          </EmptyState>
        </div>
      )}
      {all.length > 0 && (
        <div className="toolbar" role="search" style={{ marginBottom: 'var(--space-3)' }}>
          <Input type="search" aria-label="Buscar projeto" placeholder="Buscar projeto…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="toolbar-count" aria-live="polite">
            {shown.length} {shown.length === 1 ? 'projeto' : 'projetos'}
          </span>
        </div>
      )}
      {all.length > 0 && (
        <div className="card">
          {shown.length === 0 ? (
            <EmptyState title="Nenhum projeto encontrado" action={<Button onClick={() => setFilter('')}>Limpar busca</Button>}>
              Nenhum projeto corresponde à busca.
            </EmptyState>
          ) : (
            <Table label="Projetos">
              <thead>
                <tr>
                  <th>Projeto</th>
                  <th>Railway Project ID</th>
                  <th>Sincronização</th>
                  <th>Cadastrado</th>
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
        <Modal title="Cadastrar projeto" onClose={() => setMode(null)}>
          <RegisterProjectForm onDone={() => setMode(null)} />
        </Modal>
      )}
    </>
  )
}
