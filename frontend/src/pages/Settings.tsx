import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { api, isUuid } from '../api/client'
import type { Credential, CredentialKind } from '../api/types'
import { ConfirmDialog, ErrorAlert } from '../components/Modal'
import { formatDateTime } from '../format'

const STATUS_TEXT: Record<Credential['status'], string> = {
  valid: 'Válido',
  invalid: 'Recusado pelo Railway',
  undecipherable: 'Indecifrável com a chave mestra atual',
}

/** Formulário de token. O valor digitado é descartado assim que enviado. */
export function CredentialForm({ replacing, onSaved }: { replacing: boolean; onSaved?: () => void }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<CredentialKind>('account')
  const [token, setToken] = useState('')
  const [workspace, setWorkspace] = useState('')
  const workspaceInvalid = kind === 'workspace' && workspace.trim() !== '' && !isUuid(workspace)

  const save = useMutation({
    mutationFn: (input: { kind: CredentialKind; token: string; workspace_id?: string }) => api.saveCredential(input),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onSaved?.()
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const input = { kind, token, workspace_id: kind === 'workspace' ? workspace.trim() : undefined }
    // Não mantém o token em memória do componente depois de enviado.
    setToken('')
    save.mutate(input)
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Token do Railway">
      <div className="field">
        <span className="section-title">Tipo de token</span>
        <div className="radio-row">
          <label>
            <input type="radio" name="kind" checked={kind === 'account'} onChange={() => setKind('account')} /> Conta
          </label>
          <label>
            <input type="radio" name="kind" checked={kind === 'workspace'} onChange={() => setKind('workspace')} />{' '}
            Workspace (recomendado)
          </label>
        </div>
        <span className="hint">
          Tokens de projeto não são suportados: eles valem para um único ambiente e não listam projetos.
        </span>
      </div>
      {kind === 'workspace' && (
        <div className="field">
          <label htmlFor="workspace">ID do workspace</label>
          <input
            id="workspace"
            className="input mono"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            aria-invalid={workspaceInvalid}
            placeholder="00000000-0000-0000-0000-000000000000"
            required
          />
          {workspaceInvalid && <span className="error-text">Informe um UUID válido.</span>}
        </div>
      )}
      <div className="field">
        <label htmlFor="token">Token</label>
        <input
          id="token"
          className="input mono"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <span className="hint">Validado no Railway e guardado cifrado. Ele não é exibido novamente.</span>
      </div>
      <ErrorAlert error={save.error} />
      {save.isSuccess && <div className="alert alert-success">Token validado e salvo.</div>}
      <div className="row">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={save.isPending || !token.trim() || workspaceInvalid || (kind === 'workspace' && !workspace.trim())}
        >
          {save.isPending ? 'Validando…' : replacing ? 'Substituir token' : 'Validar e salvar'}
        </button>
      </div>
    </form>
  )
}

export function Settings() {
  const queryClient = useQueryClient()
  const credential = useQuery({ queryKey: ['credential'], queryFn: api.credential })
  const [replacing, setReplacing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const remove = useMutation({
    mutationFn: api.removeCredential,
    onSuccess: () => {
      setConfirmRemove(false)
      void queryClient.invalidateQueries()
    },
  })
  const current = credential.data?.credential ?? null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Configurações</h1>
          <p className="muted">Token usado para falar com a API do Railway.</p>
        </div>
      </div>
      <ErrorAlert error={credential.error} />
      <div className="card">
        <div className="card-head">
          <h3>Token do Railway</h3>
        </div>
        <div className="card-body stack">
          {current ? (
            <>
              <dl className="form-grid" style={{ margin: 0 }}>
                <div>
                  <dt className="subtle">Tipo</dt>
                  <dd style={{ margin: 0 }}>{current.kind === 'account' ? 'Conta' : 'Workspace'}</dd>
                </div>
                <div>
                  <dt className="subtle">Associado a</dt>
                  <dd style={{ margin: 0 }}>{current.label}</dd>
                </div>
                <div>
                  <dt className="subtle">Token</dt>
                  <dd className="mono" style={{ margin: 0 }}>
                    ••••••••{current.masked_suffix}
                  </dd>
                </div>
                <div>
                  <dt className="subtle">Situação</dt>
                  <dd style={{ margin: 0 }} className={current.status === 'valid' ? '' : 'result result-failed'}>
                    {STATUS_TEXT[current.status]}
                  </dd>
                </div>
                <div>
                  <dt className="subtle">Validado em</dt>
                  <dd style={{ margin: 0 }}>{formatDateTime(current.validated_at)}</dd>
                </div>
              </dl>
              {current.status !== 'valid' && (
                <div className="alert alert-warn">Cadastre um novo token para reativar a integração.</div>
              )}
              {replacing || current.status !== 'valid' ? (
                <CredentialForm replacing onSaved={() => setReplacing(false)} />
              ) : (
                <div className="row">
                  <button type="button" className="btn" onClick={() => setReplacing(true)}>
                    Substituir
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(true)}>
                    Remover
                  </button>
                </div>
              )}
            </>
          ) : (
            credential.isSuccess && <CredentialForm replacing={false} />
          )}
        </div>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title="Remover token"
          message="As operações que dependem do Railway deixam de funcionar até um novo cadastro. Projetos, serviços e histórico locais são mantidos."
          confirmLabel="Remover token"
          danger
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </>
  )
}
