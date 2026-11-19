import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'

import { useToast } from '../ui/Toast'

/** Mutation com o feedback padrão: aviso de sucesso/erro e atualização das consultas afetadas.
 *  O botão usa `isPending` em `loading`, o que também impede o envio duplicado. */
export function useFeedbackMutation<Data, Vars = void>({
  mutationFn,
  success,
  invalidate = [],
  onSuccess,
}: {
  mutationFn: (vars: Vars) => Promise<Data>
  success?: string | ((data: Data, vars: Vars) => string)
  invalidate?: QueryKey[]
  onSuccess?: (data: Data, vars: Vars) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: async (data, vars) => {
      if (success) toast.success(typeof success === 'function' ? success(data, vars) : success)
      onSuccess?.(data, vars)
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Não foi possível concluir a ação.'),
  })
}
