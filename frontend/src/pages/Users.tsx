// Gestão de usuários: só o master. Cada usuário tem um papel (permissões em cascata).

import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { api } from '../api/client'
import type { AssignableRole, ManagedUser } from '../api/types'
import { ConfirmDialog, Modal } from '../components/Modal'
import { Button } from '../components/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback'
import { Field, Input, Select } from '../components/ui/Field'
import { Table } from '../components/ui/Table'
import { useFeedbackMutation } from '../components/useFeedbackMutation'
import { relativeTime } from '../format'
import { ROLE_LABEL, useSession } from '../session'

const ROLES: AssignableRole[] = ['viewer', 'operator', 'admin']

const ROLE_HINT: Record<AssignableRole, string> = {
  viewer: 'Só consulta: visão geral, projetos, agendas, histórico e logs.',
  operator: 'Também liga e desliga serviços, atualiza estados e pausa/retoma agendas.',
  admin: 'Também gerencia projetos, serviços, agendas e o token do Railway.',
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AssignableRole>('viewer')
  const create = useFeedbackMutation({
    mutationFn: () => api.createUser({ username: username.trim(), password, role }),
    success: 'Usuário criado.',
    invalidate: [['users']],
    onSuccess: onDone,
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    create.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Novo usuário">
      <Field label="Usuário" hint="De 3 a 32 caracteres: letras, números, '.', '_' ou '-'.">
        {(p) => (
          <Input {...p} value={username} autoComplete="off" autoCapitalize="none" onChange={(e) => setUsername(e.target.value)} required autoFocus />
        )}
      </Field>
      <Field label="Senha" hint="Ao menos 8 caracteres.">
        {(p) => (
          <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        )}
      </Field>
      <Field label="Papel" hint={ROLE_HINT[role]}>
        {(p) => (
          <Select {...p} value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" loading={create.isPending} disabled={username.trim().length < 3 || password.length < 8}>
          Criar usuário
        </Button>
        <Button onClick={onDone}>Cancelar</Button>
      </div>
    </form>
  )
}

function PasswordForm({ user, onDone }: { user: ManagedUser; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const reset = useFeedbackMutation({
    mutationFn: () => api.setUserPassword(user.id, password),
    success: 'Senha redefinida; as sessões do usuário foram encerradas.',
    onSuccess: onDone,
  })
  return (
    <form
      className="stack"
      aria-label={`Nova senha de ${user.username}`}
      onSubmit={(e) => {
        e.preventDefault()
        reset.mutate()
      }}
    >
      <Field label="Nova senha" hint="Ao menos 8 caracteres.">
        {(p) => (
          <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
        )}
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" loading={reset.isPending} disabled={password.length < 8}>
          Redefinir senha
        </Button>
        <Button onClick={onDone}>Cancelar</Button>
      </div>
    </form>
  )
}

export function Users() {
  const { can } = useSession()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: can('master') })
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<ManagedUser | null>(null)
  const [removing, setRemoving] = useState<ManagedUser | null>(null)
  const update = useFeedbackMutation({
    mutationFn: (v: { id: string; role?: AssignableRole; is_active?: boolean }) => api.updateUser(v.id, { role: v.role, is_active: v.is_active }),
    success: 'Usuário atualizado.',
    invalidate: [['users']],
  })
  const remove = useFeedbackMutation({
    mutationFn: (id: string) => api.removeUser(id),
    success: 'Usuário removido.',
    invalidate: [['users']],
    onSuccess: () => setRemoving(null),
  })

  if (!can('master')) return <p className="muted">Somente o usuário master gerencia usuários.</p>
  const list = users.data?.users ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usuários</h1>
          <p className="muted">Quem pode entrar e o que cada pessoa pode fazer. O usuário master é definido no ambiente.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          Novo usuário
        </Button>
      </div>
      <ErrorState error={users.error ?? update.error} onRetry={() => void users.refetch()} />
      {users.isPending && (
        <div className="card">
          <Skeleton lines={3} label="Carregando usuários…" />
        </div>
      )}
      {users.data && list.length === 0 && (
        <div className="card">
          <EmptyState title="Nenhum usuário cadastrado">Crie usuários para dar acesso à equipe com o papel certo.</EmptyState>
        </div>
      )}
      {list.length > 0 && (
        <div className="card">
          <Table label="Usuários">
            <thead>
              <tr>
                <th>Usuário</th>
                <th>Papel</th>
                <th>Situação</th>
                <th>Criado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} data-testid="user-row">
                  <td>{u.username}</td>
                  <td>
                    <Select
                      aria-label={`Papel de ${u.username}`}
                      value={u.role}
                      disabled={update.isPending}
                      style={{ width: 'auto' }}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value as AssignableRole })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <span className={u.is_active ? 'result result-succeeded' : 'result result-skipped'}>{u.is_active ? 'Ativo' : 'Inativo'}</span>
                  </td>
                  <td>{relativeTime(u.created_at)}</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: u.id, is_active: !u.is_active })}>
                        {u.is_active ? 'Desativar' : 'Ativar'}
                      </Button>
                      <Button size="sm" onClick={() => setResetting(u)}>
                        Redefinir senha
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(u)}>
                        Remover
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {creating && (
        <Modal title="Novo usuário" onClose={() => setCreating(false)}>
          <CreateUserForm onDone={() => setCreating(false)} />
        </Modal>
      )}
      {resetting && (
        <Modal title={`Redefinir senha de ${resetting.username}`} onClose={() => setResetting(null)}>
          <PasswordForm user={resetting} onDone={() => setResetting(null)} />
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title="Remover usuário"
          message={
            <p>
              Remover <strong>{removing.username}</strong>? As sessões abertas são encerradas e o histórico de operações continua com o nome.
            </p>
          }
          confirmLabel="Remover"
          danger
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}
