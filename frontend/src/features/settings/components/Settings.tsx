import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, isUuid } from '@/shared/api/client'
import type { CredentialKind } from '@/shared/api/types'
import { LanguageSwitcher } from '@/shared/components/LanguageSwitcher/LanguageSwitcher'
import { ConfirmDialog } from '@/shared/components/Modal/Modal'
import { Button } from '@/shared/ui/Button/Button'
import { ErrorState } from '@/shared/ui/Feedback/Feedback'
import { Field, Input, RadioGroup } from '@/shared/ui/Field/Field'
import { errorMessage } from '@/shared/i18n/errors'
import { useFeedbackMutation } from '@/shared/hooks/useFeedbackMutation'
import { type ThemePreference, useTheme } from '@/shared/lib/theme'
import { formatDateTime } from '@/shared/lib/format'
import { useSession } from '@/features/auth/lib/session'

/** Formulário de token. O valor digitado é descartado assim que enviado. */
export function CredentialForm({ replacing, onSaved }: { replacing: boolean; onSaved?: () => void }) {
  const { t } = useTranslation('settings')
  const [kind, setKind] = useState<CredentialKind>('account')
  const [token, setToken] = useState('')
  const [workspace, setWorkspace] = useState('')
  const workspaceInvalid = kind === 'workspace' && workspace.trim() !== '' && !isUuid(workspace)

  const save = useFeedbackMutation({
    mutationFn: (input: { kind: CredentialKind; token: string; workspace_id?: string }) => api.saveCredential(input),
    success: t('form.saved'),
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
    <form className="stack" onSubmit={submit} aria-label={t('form.label')}>
      <RadioGroup
        legend={t('form.kindLegend')}
        name="kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'account', label: t('form.account') },
          { value: 'workspace', label: t('form.workspace') },
        ]}
      />
      <span className="subtle">
        {t('form.noProjectTokens')}
      </span>
      {kind === 'workspace' && (
        <Field label={t('form.workspaceId')} error={workspaceInvalid ? t('form.invalidUuid') : undefined}>
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
      <Field label={t('form.token')} hint={t('form.tokenHint')}>
        {(p) => (
          <Input {...p} className="mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
        )}
      </Field>
      {save.isSuccess && <div className="alert alert-success">{t('form.saved')}</div>}
      <div className="row">
        <Button
          variant="primary"
          type="submit"
          loading={save.isPending}
          disabled={!token.trim() || workspaceInvalid || (kind === 'workspace' && !workspace.trim())}
        >
          {save.isPending ? t('form.validating') : replacing ? t('form.replaceToken') : t('form.validateSave')}
        </Button>
      </div>
    </form>
  )
}

const THEMES: ThemePreference[] = ['system', 'light', 'dark']

function Appearance() {
  const { t } = useTranslation('settings')
  const { preference, setPreference } = useTheme()
  const options = THEMES.map((value) => ({ value, label: t(`theme.${value}`) }))
  return (
    <div className="card" style={{ marginTop: 'var(--space-4)' }}>
      <div className="card-head">
        <h3>{t('theme.appearance')}</h3>
      </div>
      <div className="card-body">
        <RadioGroup legend={t('theme.legend')} name="theme" value={preference} options={options} onChange={setPreference} />
      </div>
      <div className="card-head">
        <h3>{t('language.title')}</h3>
      </div>
      <div className="card-body">
        <span className="subtle">{t('language.legend')}</span> <LanguageSwitcher />
      </div>
    </div>
  )
}

export function Settings() {
  const { t } = useTranslation('settings')
  const credential = useQuery({ queryKey: ['credential'], queryFn: api.credential })
  const canManage = useSession().can('admin')
  const [replacing, setReplacing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const remove = useFeedbackMutation({
    mutationFn: api.removeCredential,
    success: t('removed'),
    invalidate: [[]],
    onSuccess: () => setConfirmRemove(false),
  })
  const current = credential.data?.credential ?? null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('subtitle')}</p>
        </div>
      </div>
      <ErrorState error={credential.error} onRetry={() => void credential.refetch()} />
      <div className="card">
        <div className="card-head">
          <h3>{t('tokenCard')}</h3>
        </div>
        <div className="card-body stack">
          {current ? (
            <>
              <dl className="form-grid" style={{ margin: 0 }}>
                <div>
                  <dt className="subtle">{t('info.type')}</dt>
                  <dd style={{ margin: 0 }}>{current.kind === 'account' ? t('info.account') : t('info.workspace')}</dd>
                </div>
                <div>
                  <dt className="subtle">{t('info.linkedTo')}</dt>
                  <dd style={{ margin: 0 }}>{current.label}</dd>
                </div>
                <div>
                  <dt className="subtle">{t('info.token')}</dt>
                  <dd className="mono" style={{ margin: 0 }}>
                    ••••••••{current.masked_suffix}
                  </dd>
                </div>
                <div>
                  <dt className="subtle">{t('info.status')}</dt>
                  <dd style={{ margin: 0 }} className={current.status === 'valid' ? '' : 'result result-failed'}>
                    {t(`status.${current.status}`)}
                  </dd>
                </div>
                <div>
                  <dt className="subtle">{t('info.validatedAt')}</dt>
                  <dd style={{ margin: 0 }}>{formatDateTime(current.validated_at)}</dd>
                </div>
              </dl>
              {current.status !== 'valid' && (
                <div className="alert alert-warn">
                  {canManage ? t('reactivate') : t('inactive')}
                </div>
              )}
              {!canManage ? null : replacing || current.status !== 'valid' ? (
                <CredentialForm replacing onSaved={() => setReplacing(false)} />
              ) : (
                <div className="row">
                  <Button onClick={() => setReplacing(true)}>{t('replace')}</Button>
                  <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                    {t('remove')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            credential.isSuccess &&
            (canManage ? (
              <CredentialForm replacing={false} />
            ) : (
              <p className="muted">{t('none')}</p>
            ))
          )}
        </div>
      </div>
      <Appearance />
      {confirmRemove && (
        <ConfirmDialog
          title={t('removeTitle')}
          message={t('removeMessage')}
          confirmLabel={t('removeTitle')}
          danger
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </>
  )
}
