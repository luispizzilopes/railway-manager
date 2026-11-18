import type { ReactNode } from 'react'

import './Table.css'

/** Tabela densa com rolagem horizontal contida; colunas numéricas usam a classe `num`. */
export function Table({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div className="table-wrap">
      <table className={`table${className ? ` ${className}` : ''}`} aria-label={label}>
        {children}
      </table>
    </div>
  )
}
