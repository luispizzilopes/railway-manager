// Quem está logado e o que o papel permite. O backend é quem impõe as permissões;
// aqui só se escondem os controles que dariam 403.

import { useQuery } from '@tanstack/react-query'

import { api } from '@/shared/api/client'
import type { Role } from '@/shared/api/types'

const ORDER: Role[] = ['viewer', 'operator', 'admin', 'master']

export function roleAllows(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && ORDER.indexOf(role) >= ORDER.indexOf(minimum)
}

export const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Somente leitura',
  operator: 'Operador',
  admin: 'Administrador',
  master: 'Master',
}

export function useSession() {
  const { data } = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false, staleTime: Infinity })
  return {
    username: data?.username,
    role: data?.role,
    /** `true` quando o papel atual é pelo menos `minimum`. */
    can: (minimum: Role) => roleAllows(data?.role, minimum),
  }
}
