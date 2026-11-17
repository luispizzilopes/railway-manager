import { Console } from '../console/Console'

export function ConsolePage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Console</h1>
          <p className="muted">
            Tudo o que a interface faz, em uma linha. Digite <code>help</code> para ver os comandos; abra este console em
            qualquer tela com Ctrl+` ou Ctrl+K.
          </p>
        </div>
      </div>
      <Console variant="page" />
    </>
  )
}
