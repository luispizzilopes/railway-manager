import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { PROJECT } from '@/test/fixtures'
import { mockFetch, renderWithProviders } from '@/test/utils'
import { AssociateForm } from '@/features/projects/components/ProjectDetail'
import { RegisterProjectForm } from '@/features/projects/components/Projects'

const ID = '00000000-0000-4000-8000-000000000001'

describe('cadastro de projeto', () => {
  it('valida o formato do ID antes de chamar a API', async () => {
    const calls = mockFetch({})
    renderWithProviders(<RegisterProjectForm onDone={() => {}} />)
    await userEvent.type(screen.getByLabelText('Railway Project ID'), 'meu-projeto')
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }))
    expect(screen.getByText(/Informe o ID do projeto/)).toBeInTheDocument()
    expect(screen.getByLabelText('Railway Project ID')).toHaveAttribute('aria-invalid', 'true')
    expect(calls).toHaveLength(0)
  })

  it('envia ID válido e mostra o erro de duplicidade do backend', async () => {
    const calls = mockFetch({
      'POST /api/projects': () => ({ status: 409, json: { code: 'conflict', message: 'o projeto já está cadastrado' } }),
    })
    renderWithProviders(<RegisterProjectForm onDone={() => {}} />)
    await userEvent.type(screen.getByLabelText('Railway Project ID'), ID)
    await userEvent.type(screen.getByLabelText('Nome de exibição (opcional)'), 'Loja')
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('o projeto já está cadastrado')
    expect(calls[0].body).toEqual({ railway_project_id: ID, display_name: 'Loja' })
  })

  it('conclui o cadastro', async () => {
    mockFetch({ 'POST /api/projects': () => ({ status: 201, json: { project: PROJECT } }) })
    let done = false
    renderWithProviders(<RegisterProjectForm onDone={() => (done = true)} />)
    await userEvent.type(screen.getByLabelText('Railway Project ID'), ID)
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }))
    await screen.findByRole('button', { name: 'Cadastrar' })
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(true)
  })
})

describe('associação manual', () => {
  it('exige UUIDs de serviço e ambiente', async () => {
    const calls = mockFetch({})
    renderWithProviders(<AssociateForm projectId="p-1" onDone={() => {}} />)
    await userEvent.type(screen.getByLabelText('Railway Service ID'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Associar' }))
    expect(screen.getAllByText('UUID inválido.')).toHaveLength(2)
    expect(calls).toHaveLength(0)
  })

  it('mostra recusa do Railway (serviço de outro projeto)', async () => {
    mockFetch({
      'POST /api/projects/p-1/instances': () => ({
        status: 422,
        json: { code: 'unprocessable', message: 'o serviço não pertence ao projeto' },
      }),
    })
    renderWithProviders(<AssociateForm projectId="p-1" onDone={() => {}} />)
    await userEvent.type(screen.getByLabelText('Railway Service ID'), ID)
    await userEvent.type(screen.getByLabelText('Railway Environment ID'), ID)
    await userEvent.click(screen.getByRole('button', { name: 'Associar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('o serviço não pertence ao projeto')
  })
})
