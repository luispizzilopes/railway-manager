import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Brand } from '@/shared/components/Brand/Brand'
import { LanguageSwitcher } from '@/shared/components/LanguageSwitcher/LanguageSwitcher'
import { errorMessage } from '@/shared/i18n/errors'
import { api } from '@/shared/api/client'
import { Button } from '@/shared/ui/Button/Button'
import { Field, Input } from '@/shared/ui/Field/Field'

export function Login({ onLogin, onCli }: { onLogin: () => void; onCli?: () => void }) {
  const { t } = useTranslation('auth')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(username.trim(), password)
      setPassword('')
      onLogin()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <LanguageSwitcher className="login-lang" />
      <form className="card" onSubmit={submit}>
        <div className="login-head">
          <Brand />
          <h1>{t('login.title')}</h1>
          <p className="muted">{t('login.subtitle')}</p>
        </div>
        <div className="stack">
          <Field label={t('login.username')}>
            {(p) => (
              <Input
                {...p}
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
              />
            )}
          </Field>
          <Field label={t('login.password')}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}
          </Field>
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <Button variant="primary" type="submit" loading={busy} disabled={!username.trim() || !password}>
            {t('login.submit')}
          </Button>
          {onCli && (
            <Button variant="ghost" onClick={onCli}>
              {t('login.toCli')}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
