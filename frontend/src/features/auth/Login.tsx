import { type FormEvent, useState } from 'react'

import { Brand } from '@/shared/components/Brand'
import { ApiError, api } from '@/shared/api/client'
import { Button } from '@/shared/ui/Button'
import { Field, Input } from '@/shared/ui/Field'

export function Login({ onLogin, onCli }: { onLogin: () => void; onCli?: () => void }) {
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
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="login-head">
          <Brand />
          <h1>Entrar</h1>
          <p className="muted">Entre com seu usuário e senha.</p>
        </div>
        <div className="stack">
          <Field label="Usuário">
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
          <Field label="Senha">
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
            Entrar
          </Button>
          {onCli && (
            <Button variant="ghost" onClick={onCli}>
              Mudar para linha de comando (CLI)
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
