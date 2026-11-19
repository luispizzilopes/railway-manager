import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { api, isUuid } from '@/shared/api/client'
import type { Credential, CredentialKind } from '@/shared/api/types'
import { ConfirmDialog } from '@/shared/components/Modal'
import { Button } from '@/shared/ui/Button'
import { ErrorState } from '@/shared/ui/Feedback'
import { Field, Input, RadioGroup } from '@/shared/ui/Field'
import { useFeedbackMutation } from '@/shared/components/useFeedbackMutation'
import { type ThemePreference, useTheme } from '@/shared/lib/theme'
import { formatDateTime } from '@/shared/lib/format'
import { useSession } from '../auth/session'

const STATUS_TEXT: Record<Credential['status'], string> = {
  valid: 'Válido',
  invalid: 'Recusado pelo Railway',
  undecipherable: 'Indecifrável com a chave mestra atual',
}

/** Formulário de token. O valor digitado é descartado assim que enviado. */
export function CredentialForm({ replacing, onSaved }: { replacing: boolean; onSaved?: () => void }) {
  const [kind, setKind] = useState<CredentialKind>('account')
  const [token, setToken] = useState('')
  const [workspace, setWorkspace] = useState('')
  const workspaceInvalid = kind === 'workspace' && workspace.trim() !== '' && !isUuid(workspace)

  const save = useFeedbackMutation({
    mutationFn: (input: { kind: CredentialKind; token: string; workspace_id?: string }) => api.saveCredential(input),
    success: 'Token validado e salvo.',
    invalidate: [[]],
    onSuccess: () => onSaved?.(),
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
      <RadioGroup
        legend="Tipo de token"
        name="kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'account', label: 'Conta' },
          { value: 'workspace', label: 'Workspace (recomendado)' },
        ]}
      />
      <span className="subtle">
        Tokens de projeto não são suportados: eles valem para um único ambiente e não listam projetos.
      </span>
      {kind === 'workspace' && (
        <Field label="ID do workspace" error={workspaceInvalid ? 'Informe um UUID válido.' : undefined}>
          {(p) => (
            <Input
              {...p}
              className="mono"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              required
            />
          )}
        </Field>
      )}
      <Field label="Token" hint="Validado no Railway e guardado cifrado. Ele não é exibido novamente.">
        {(p) => (
          <Input {...p} className="mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
        )}
      </Field>
      {save.isSuccess && <div className="alert alert-success">Token validado e salvo.</div>}
      <div className="row">
        <Button
          variant="primary"
          type="submit"
          loading={save.isPending}
          disabled={!token.trim() || workspaceInvalid || (kind === 'workspace' && !workspace.trim())}
        >
          {save.isPending ? 'Validando…' : replacing ? 'Substituir token' : 'Validar e salvar'}
        </Button>
      </div>
    </form>
  )
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Seguir o sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

function Appearance() {
  const { preference, setPreference } = useTheme()
  return (
    <div className="card" style={{ marginTop: 'var(--space-4)' }}>
      <div className="card-head">
        <h3>Aparência</h3>
      </div>
      <div className="card-body">
        <RadioGroup legend="Tema" name="theme" value={preference} options={THEME_OPTIONS} onChange={setPreference} />
      </div>
    </div>
  )
}

export function Settings() {
  const credential = useQuery({ queryKey: ['credential'], queryFn: api.credential })
  const canManage = useSession().can('admin')
  const [replacing, setReplacing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const remove = useFeedbackMutation({
    mutationFn: api.removeCredential,
    success: 'Token removido.',
    invalidate: [[]],
    onSuccess: () => setConfirmRemove(false),
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
      <ErrorState error={credential.error} onRetry={() => void credential.refetch()} />
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
                <div className="alert alert-warn">
                  {canManage ? 'Cadastre um novo token para reativar a integração.' : 'A integração está inativa: avise um administrador.'}
                </div>
              )}
              {!canManage ? null : replacing || current.status !== 'valid' ? (
                <CredentialForm replacing onSaved={() => setReplacing(false)} />
              ) : (
                <div className="row">
                  <Button onClick={() => setReplacing(true)}>Substituir</Button>
                  <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                    Remover
                  </Button>
                </div>
              )}
            </>
          ) : (
            credential.isSuccess &&
            (canManage ? (
              <CredentialForm replacing={false} />
            ) : (
              <p className="muted">Nenhum token cadastrado. Peça a um administrador para cadastrá-lo.</p>
            ))
          )}
        </div>
      </div>
      <Appearance />
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
