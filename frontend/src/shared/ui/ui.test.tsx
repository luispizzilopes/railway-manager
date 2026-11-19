import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { STATE_LABEL } from '../lib/format'
import type { ObservedState } from '../api/types'
import { Modal } from '../components/Modal'
import { useFeedbackMutation } from '../components/useFeedbackMutation'
import { Button, Field, Input, StatusBadge, Tabs, ToastProvider, useToast } from './index'
import { TOAST_MS } from './Toast'

describe('Button', () => {
  it('em carregamento fica desabilitado e não envia duas vezes', async () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>Salvar</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(
      <Button onClick={onClick} loading>
        Salvar
      </Button>,
    )
    const busy = screen.getByRole('button', { name: 'Salvar' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(busy)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Field', () => {
  it('liga rótulo, dica e erro ao controle', () => {
    render(
      <Field label="Nome" hint="Como aparece nas listas" error="Obrigatório">
        {(p) => <Input {...p} />}
      </Field>,
    )
    const input = screen.getByLabelText('Nome')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Como aparece nas listas Obrigatório')
  })
})

describe('StatusBadge', () => {
  it('cada estado tem texto próprio e um ícone, além da cor', () => {
    const states = Object.keys(STATE_LABEL) as ObservedState[]
    const { container } = render(
      <>
        {states.map((s) => (
          <StatusBadge key={s} state={s} />
        ))}
      </>,
    )
    for (const s of states) expect(screen.getByText(STATE_LABEL[s])).toBeInTheDocument()
    expect(container.querySelectorAll('svg.badge-icon')).toHaveLength(states.length)
    // as formas são distintas entre si
    const shapes = [...container.querySelectorAll('svg.badge-icon')].map((n) => n.innerHTML)
    expect(new Set(shapes).size).toBe(states.length)
  })
})

describe('Tabs', () => {
  function Demo() {
    const [value, setValue] = useState('a')
    return (
      <Tabs
        label="Seções"
        value={value}
        onChange={setValue}
        items={[
          { id: 'a', label: 'Primeira' },
          { id: 'b', label: 'Segunda' },
          { id: 'c', label: 'Terceira' },
        ]}
      />
    )
  }

  it('navega com setas, Home e End', async () => {
    render(<Demo />)
    const [first, second, third] = screen.getAllByRole('tab')
    first.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(second).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(third).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(first).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Modal', () => {
  it('Esc fecha e o foco volta a quem abriu', async () => {
    function Demo() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Abrir
          </button>
          {open && (
            <Modal title="Editar" onClose={() => setOpen(false)}>
              <input aria-label="Nome" />
            </Modal>
          )}
        </>
      )
    }
    render(<Demo />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    await userEvent.click(opener)
    expect(await screen.findByRole('dialog', { name: 'Editar' })).toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })
})

describe('Toast', () => {
  it('aparece e some sozinho', () => {
    vi.useFakeTimers()
    function Demo() {
      const toast = useToast()
      return (
        <button type="button" onClick={() => toast.success('Salvo.')}>
          Salvar
        </button>
      )
    }
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    )
    act(() => screen.getByRole('button', { name: 'Salvar' }).click())
    expect(screen.getByRole('status')).toHaveTextContent('Salvo.')
    act(() => {
      vi.advanceTimersByTime(TOAST_MS.success + 10)
    })
    expect(screen.queryByText('Salvo.')).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})

describe('useFeedbackMutation', () => {
  function Demo({ fn }: { fn: () => Promise<void> }) {
    const save = useFeedbackMutation({ mutationFn: fn, success: 'Salvo com sucesso.' })
    return (
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        Salvar
      </Button>
    )
  }
  const wrap = (fn: () => Promise<void>) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <ToastProvider>
          <Demo fn={fn} />
        </ToastProvider>
      </QueryClientProvider>,
    )

  it('avisa o sucesso e não envia duas vezes durante a ação', async () => {
    let resolve!: () => void
    const fn = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    wrap(fn)
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
    await act(async () => resolve())
    expect(await screen.findByText('Salvo com sucesso.')).toBeInTheDocument()
  })

  it('mostra o erro como aviso', async () => {
    wrap(() => Promise.reject(new Error('o Railway recusou')))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('o Railway recusou')
  })
})
