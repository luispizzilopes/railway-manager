import type { Mode } from '../mode'

/** Antes do login: interface gráfica ou só linha de comando. A escolha fica salva. */
export function ModeChooser({ onChoose }: { onChoose: (mode: Mode) => void }) {
  return (
    <div className="login">
      <div className="card mode-card">
        <div className="login-head">
          <div className="side-brand">
            Railway<span>Manager</span>
          </div>
          <h1>Como você quer usar?</h1>
          <p className="muted">Dá para trocar depois, a qualquer momento.</p>
        </div>
        <div className="mode-options">
          <button type="button" className="mode-option" onClick={() => onChoose('ui')}>
            <strong>Interface gráfica</strong>
            <span className="muted">Telas, botões e painéis. O console continua disponível com Ctrl+` ou Ctrl+K.</span>
          </button>
          <button type="button" className="mode-option" onClick={() => onChoose('cli')}>
            <strong>Somente linha de comando (CLI)</strong>
            <span className="muted">Tudo por comandos, inclusive o login. Digite ui para voltar à interface.</span>
          </button>
        </div>
      </div>
    </div>
  )
}
