import { type FormEvent, useState } from 'react'

import { ApiError, api } from '../api/client'

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
          <div className="side-brand">
            Railway<span>Manager</span>
          </div>
          <h1>Entrar</h1>
          <p className="muted">Entre com a senha de administrador.</p>
        </div>
        <div className="stack">
          <div className="field">
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            Entrar
          </button>
          {onCli && (
            <button type="button" className="btn btn-ghost" onClick={onCli}>
              Mudar para linha de comando (CLI)
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
