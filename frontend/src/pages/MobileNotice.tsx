/** Celulares ainda não são suportados: a interface e o console foram feitos para telas grandes. */
export function isMobileDevice(): boolean {
  return /Android|iPhone|iPod|Mobi/i.test(window.navigator.userAgent)
}

export function MobileNotice() {
  return (
    <div className="login">
      <div className="card mode-card">
        <div className="login-head">
          <div className="side-brand">
            Railway<span>Manager</span>
          </div>
          <h1>Celular não suportado</h1>
          <p className="muted">
            O Railway Manager ainda não é compatível com celulares. Acesse por um computador ou tablet.
          </p>
        </div>
      </div>
    </div>
  )
}
