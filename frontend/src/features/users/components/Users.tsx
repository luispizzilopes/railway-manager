// Gestão de usuários: só o master. Cada usuário tem um papel (permissões em cascata).

import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { api } from '@/shared/api/client'
import type { AssignableRole, ManagedUser } from '@/shared/api/types'
import { ConfirmDialog, Modal } from '@/shared/components/Modal/Modal'
import { Button } from '@/shared/ui/Button/Button'
import { EmptyState, ErrorState, Skeleton } from '@/shared/ui/Feedback/Feedback'
import { Field, Input, Select } from '@/shared/ui/Field/Field'
import { Table } from '@/shared/ui/Table/Table'
import { errorMessage } from '@/shared/i18n/errors'
import { useFeedbackMutation } from '@/shared/hooks/useFeedbackMutation'
import { relativeTime } from '@/shared/lib/format'
import { roleLabel, useSession } from '@/features/auth/lib/session'

const ROLES: AssignableRole[] = ['viewer', 'operator', 'admin']

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('users')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AssignableRole>('viewer')
  const create = useFeedbackMutation({
    mutationFn: () => api.createUser({ username: username.trim(), password, role }),
    success: t('create.done'),
    invalidate: [['users']],
    onSuccess: onDone,
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    create.mutate()
  }

  return (
    <form className="stack" onSubmit={submit} aria-label={t('create.label')}>
      <Field label={t('create.username')} hint={t('create.usernameHint')}>
        {(p) => (
          <Input {...p} value={username} autoComplete="off" autoCapitalize="none" onChange={(e) => setUsername(e.target.value)} required autoFocus />
        )}
      </Field>
      <Field label={t('create.password')} hint={t('create.passwordHint')}>
        {(p) => (
          <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        )}
      </Field>
      <Field label={t('create.role')} hint={t(`hint.${role}`)}>
        {(p) => (
          <Select {...p} value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" loading={create.isPending} disabled={username.trim().length < 3 || password.length < 8}>
          {t('create.submit')}
        </Button>
        <Button onClick={onDone}>{t('ui.cancel', { ns: 'common' })}</Button>
      </div>
    </form>
  )
}

function PasswordForm({ user, onDone }: { user: ManagedUser; onDone: () => void }) {
  const { t } = useTranslation('users')
  const [password, setPassword] = useState('')
  const reset = useFeedbackMutation({
    mutationFn: () => api.setUserPassword(user.id, password),
    success: t('password.done'),
    onSuccess: onDone,
  })
  return (
    <form
      className="stack"
      aria-label={t('password.label', { user: user.username })}
      onSubmit={(e) => {
        e.preventDefault()
        reset.mutate()
      }}
    >
      <Field label={t('password.field')} hint={t('create.passwordHint')}>
        {(p) => (
          <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
        )}
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" loading={reset.isPending} disabled={password.length < 8}>
          {t('password.submit')}
        </Button>
        <Button onClick={onDone}>{t('ui.cancel', { ns: 'common' })}</Button>
      </div>
    </form>
  )
}

export function Users() {
  const { t } = useTranslation('users')
  const { can } = useSession()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: can('master') })
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<ManagedUser | null>(null)
  const [removing, setRemoving] = useState<ManagedUser | null>(null)
  const update = useFeedbackMutation({
    mutationFn: (v: { id: string; role?: AssignableRole; is_active?: boolean }) => api.updateUser(v.id, { role: v.role, is_active: v.is_active }),
    success: t('updated'),
    invalidate: [['users']],
  })
  const remove = useFeedbackMutation({
    mutationFn: (id: string) => api.removeUser(id),
    success: t('removed'),
    invalidate: [['users']],
    onSuccess: () => setRemoving(null),
  })

  if (!can('master')) return <p className="muted">{t('denied')}</p>
  const list = users.data?.users ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('new')}
        </Button>
      </div>
      <ErrorState error={users.error ?? update.error} onRetry={() => void users.refetch()} />
      {users.isPending && (
        <div className="card">
          <Skeleton lines={3} label={t('loading')} />
        </div>
      )}
      {users.data && list.length === 0 && (
        <div className="card">
          <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
        </div>
      )}
      {list.length > 0 && (
        <div className="card">
          <Table label={t('table')}>
            <thead>
              <tr>
                <th>{t('user')}</th>
                <th>{t('role')}</th>
                <th>{t('status')}</th>
                <th>{t('created')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} data-testid="user-row">
                  <td>{u.username}</td>
                  <td>
                    <Select
                      aria-label={t('roleOf', { user: u.username })}
                      value={u.role}
                      disabled={update.isPending}
                      style={{ width: 'auto' }}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value as AssignableRole })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <span className={u.is_active ? 'result result-succeeded' : 'result result-skipped'}>{u.is_active ? t('active') : t('inactive')}</span>
                  </td>
                  <td>{relativeTime(u.created_at)}</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: u.id, is_active: !u.is_active })}>
                        {u.is_active ? t('deactivate') : t('activate')}
                      </Button>
                      <Button size="sm" onClick={() => setResetting(u)}>
                        {t('resetPassword')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(u)}>
                        {t('remove')}
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
        <Modal title={t('create.label')} onClose={() => setCreating(false)}>
          <CreateUserForm onDone={() => setCreating(false)} />
        </Modal>
      )}
      {resetting && (
        <Modal title={t('password.title', { user: resetting.username })} onClose={() => setResetting(null)}>
          <PasswordForm user={resetting} onDone={() => setResetting(null)} />
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={t('removeTitle')}
          message={
            <p>
              <Trans t={t} i18nKey="removeMessage" values={{ user: removing.username }} components={{ 1: <strong /> }} />
            </p>
          }
          confirmLabel={t('remove')}
          danger
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}
