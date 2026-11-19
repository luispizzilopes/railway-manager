// Modo de uso escolhido antes do login: interface gráfica ou só linha de comando.
// Guardado neste navegador; falhas de armazenamento valem como "sem escolha".

export type Mode = 'ui' | 'cli'

const KEY = 'rm:mode'

export function readMode(): Mode | null {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'ui' || value === 'cli' ? value : null
  } catch {
    return null
  }
}

export function writeMode(mode: Mode) {
  try {
    window.localStorage.setItem(KEY, mode)
  } catch {
    // sem persistência: vale só nesta visita
  }
}
