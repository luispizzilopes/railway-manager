import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import { api, isUuid } from '../api/client'
import type { ProjectImportReport } from '../api/types'
import { ErrorAlert, Modal } from '../components/Modal'
import { SYNC_LABEL, relativeTime } from '../format'

/** Cadastro manual por Railway Project ID. */
export function RegisterProjectForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const invalid = id.trim() !== '' && !isUuid(id)
  const create = useMutation({
    mutationFn: () => api.createProject(id.trim(), name.trim() || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onDone()
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!isUuid(id)) return
    create.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Cadastrar projeto">
      <div className="field">
        <label htmlFor="railway-project-id">Railway Project ID</label>
        <input
          id="railway-project-id"
          className="input mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && (invalid || !id.trim())}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        {touched && (invalid || !id.trim()) && (
          <span className="error-text">Informe o ID do projeto (UUID), como aparece nas configurações do projeto.</span>
        )}
      </div>
      <div className="field">
        <label htmlFor="display-name">Nome de exibição (opcional)</label>
        <input id="display-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="hint">O nome e a descrição vêm do Railway; este nome só muda aqui.</span>
      </div>
      <ErrorAlert error={create.error} />
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Validando no Railway…' : 'Cadastrar'}
        </button>
      </div>
    </form>
  )
}

function DiscoverProjects({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const discovery = useQuery({ queryKey: ['discover-projects'], queryFn: api.discoverProjects })
  const [selected, setSelected] = useState<string[]>([])
  const [report, setReport] = useState<ProjectImportReport | null>(null)
  const importMany = useMutation({
    mutationFn: () => api.importProjects(selected),
    onSuccess: (r) => {
      setReport(r)
      setSelected([])
      void queryClient.invalidateQueries()
    },
  })
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Modal
      title="Importar projetos do Railway"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0 || importMany.isPending}
            onClick={() => importMany.mutate()}
          >
            Importar {selected.length || ''}
          </button>
        </>
      }
    >
      <ErrorAlert error={discovery.error ?? importMany.error} />
      {report && (
        <div className="alert alert-success" role="status">
          {report.imported.length} importado(s)
          {report.already_managed.length > 0 && `, ${report.already_managed.length} já gerenciado(s)`}
          {report.failed.length > 0 && `, ${report.failed.length} com falha: ${report.failed.map((f) => f.reason).join('; ')}`}.
        </div>
      )}
      {discovery.isPending && <p className="muted">Consultando o Railway…</p>}
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projetos</h1>
          <p className="muted">Projetos do Railway sob gerenciamento. Nada aqui cria ou exclui projetos no Railway.</p>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => setMode('manual')}>
            Cadastrar por ID
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setMode('discover')}>
            Importar da conta
          </button>
        </div>
      </div>
      <ErrorAlert error={projects.error} />
      {projects.data && projects.data.projects.length === 0 && (
        <div className="card empty">
          <h3>Nenhum projeto ainda</h3>
          <p>Importe a partir da conta ou cadastre pelo Railway Project ID.</p>
        </div>
      )}
      {projects.data && projects.data.projects.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Projeto</th>
                <th>Railway Project ID</th>
                <th>Sincronização</th>
                <th>Cadastrado</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
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
          </table>
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
