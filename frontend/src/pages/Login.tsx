import { type FormEvent, useState } from 'react'

import { Brand } from '../components/Brand'
import { ApiError, api } from '../api/client'
import { Button } from '../components/ui/Button'
import { Field, Input } from '../components/ui/Field'

export function Login({ onLogin, onCli }: { onLogin: () => void; onCli?: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
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
          <p className="muted">Entre com a senha de administrador.</p>
        </div>
        <div className="stack">
          <Field label="Senha">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
            )}
          </Field>
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <Button variant="primary" type="submit" loading={busy} disabled={!password}>
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
